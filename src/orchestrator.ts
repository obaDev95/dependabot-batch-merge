import * as core from '@actions/core';
import type { FailureAnalyzer } from './analysis/analyzer';
import type { BranchManager } from './git/branch-manager';
import type { PRMerger } from './git/merger';
import type { DependabotPRLister } from './github/pr-lister';
import type { BatchPRRef, BatchPRWriter } from './github/pr-writer';
import type { ReportBuilder } from './report/builder';
import type { AgenticResolver } from './resolve/claude-resolver';
import type {
  AgentAttempt,
  AgentGaveUp,
  BatchConfig,
  BatchSummary,
  DependabotPR,
  FailureExplanation,
  MergeOutcome,
  PRResult,
  PushRejectReason,
  ValidationOutcome,
} from './types';
import type { ValidationRunner } from './validation/command-runner';

/** PATCH the batch PR body at most every N processed PRs during the merge loop. */
const BODY_UPDATE_INTERVAL = 5;

type ProcessStepOutcome =
  | { kind: 'pass'; pushed: boolean }
  | { kind: 'merge-conflict'; files: string[] }
  | {
      kind: 'push-rejected';
      reason: PushRejectReason;
      message: string;
    }
  | { kind: 'validation-failed'; explanation: FailureExplanation; pushed: boolean };

export class BatchOrchestrator {
  constructor(
    private readonly prLister: DependabotPRLister,
    private readonly branchManager: BranchManager,
    private readonly merger: PRMerger,
    private readonly validator: ValidationRunner,
    private readonly analyzer: FailureAnalyzer,
    private readonly reporter: ReportBuilder,
    private readonly prWriter: BatchPRWriter,
    private readonly resolver: AgenticResolver,
  ) {}

  async run(config: BatchConfig): Promise<BatchSummary> {
    const integrationBranch = await this.branchManager.createIntegrationBranch(
      config.integrationBranchPrefix,
      config.baseBranch,
    );
    core.info(`Integration branch: ${integrationBranch}`);

    const candidates = await this.prLister.extractOpenPullRequests(
      config.dependabotAuthor,
      config.maxPrs,
    );
    core.info(`Found ${candidates.length} open Dependabot PR(s)`);

    // Reuse an existing same-day PR if present; otherwise defer creation until
    // the integration branch has at least one commit ahead of base. GitHub
    // returns 422 "No commits between base and head" when opening a PR against
    // an empty branch, which happens on the first run of a new day before any
    // candidate has been merged.
    let batchPr: BatchPRRef | null = await this.prWriter.findExistingPr(
      integrationBranch,
      config.baseBranch,
    );
    if (batchPr) {
      core.info(`Reusing existing batch PR #${batchPr.number}`);
      await this.prWriter.updatePrBody(
        batchPr.number,
        this.placeholderBody(integrationBranch, config, candidates.length),
      );
    }

    const results: PRResult[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const pr = candidates[i]!;
      core.startGroup(`Processing PR #${pr.number} — ${pr.title}`);
      const { result, pushed } = await this.processPr(pr, config, integrationBranch);
      results.push(result);

      if (pushed && !batchPr) {
        batchPr = await this.openBatchPr(integrationBranch, config);
      }
      if (batchPr && this.shouldUpdateBodyDuringLoop(i)) {
        await this.updateBatchPrBody(batchPr.number, integrationBranch, config.baseBranch, results);
      }
      core.endGroup();
    }

    let finalSuite: ValidationOutcome | undefined;
    if (config.reRunFinalSuite && results.some((r) => r.status === 'PASS')) {
      core.info('Running final validation on integration branch tip');
      finalSuite = await this.validator.run();
    }

    if (batchPr) {
      await this.updateBatchPrBody(
        batchPr.number,
        integrationBranch,
        config.baseBranch,
        results,
        finalSuite,
      );
      if (!config.draftPr) {
        await this.prWriter.markPrAsReady(batchPr.number);
      }
    } else {
      core.info('No commits landed on the integration branch — no batch PR opened.');
    }

    return {
      ...(batchPr && { batchPrNumber: batchPr.number, batchPrUrl: batchPr.url }),
      results,
      ...(finalSuite && { finalSuite }),
    };
  }

  private shouldUpdateBodyDuringLoop(processedIndex: number): boolean {
    return (processedIndex + 1) % BODY_UPDATE_INTERVAL === 0;
  }

  private async updateBatchPrBody(
    prNumber: number,
    integrationBranch: string,
    baseBranch: string,
    results: PRResult[],
    finalSuite?: ValidationOutcome,
  ): Promise<void> {
    await this.prWriter.updatePrBody(
      prNumber,
      this.reporter.build({
        integrationBranch,
        baseBranch,
        results,
        ...(finalSuite && { finalSuite }),
      }),
    );
  }

  private async processPr(
    pr: DependabotPR,
    config: BatchConfig,
    integrationBranch: string,
  ): Promise<{ result: PRResult; pushed: boolean }> {
    await this.branchManager.fetchPr(pr.headRef);

    const preMergeSha = await this.merger.headSha();
    const mergeOutcome = await this.attemptMerge(pr);

    if (mergeOutcome.kind === 'conflict') {
      return this.handleMergeConflict(
        pr,
        config,
        integrationBranch,
        mergeOutcome.conflictedFiles ?? [],
        preMergeSha,
      );
    }

    const validation = await this.validator.run();
    if (validation.passed) {
      return this.validateAndPush(pr, integrationBranch, validation);
    }

    return this.handleValidationFailure(pr, config, integrationBranch, validation, preMergeSha);
  }

  private async handleMergeConflict(
    pr: DependabotPR,
    config: BatchConfig,
    integrationBranch: string,
    conflictedFiles: string[],
    preMergeSha: string,
  ): Promise<{ result: PRResult; pushed: boolean }> {
    if (config.agenticResolve) {
      const resolution = await this.resolver.resolveConflict({ pr, conflictedFiles });
      if (resolution.kind === 'resolved') {
        const agentAttempt: AgentAttempt = {
          commitSha: resolution.commitSha,
          summary: resolution.summary,
          outputTail: resolution.outputTail,
        };
        const validation = await this.validator.run();
        if (validation.passed) {
          return this.validateAndPush(pr, integrationBranch, validation, agentAttempt);
        }
        core.warning(`PR #${pr.number}: agent conflict fix did not pass validation, resetting`);
        await this.merger.resetTo(preMergeSha);
        const explanation = await this.analyzer.explain({ pr, validation });
        return {
          result: this.toPrResult(pr, { kind: 'validation-failed', explanation, pushed: false }, agentAttempt),
          pushed: false,
        };
      }
      core.warning(`PR #${pr.number}: agent gave up on conflict: ${resolution.reason}`);
      await this.merger.abortMerge();
      const gaveUp: AgentGaveUp = {
        stage: 'conflict',
        reason: resolution.reason,
        outputTail: resolution.outputTail,
      };
      return {
        result: this.toPrResult(pr, { kind: 'merge-conflict', files: conflictedFiles }, undefined, gaveUp),
        pushed: false,
      };
    }

    await this.merger.abortMerge();
    core.warning(`Merge conflict for PR #${pr.number}`);
    return {
      result: this.toPrResult(pr, { kind: 'merge-conflict', files: conflictedFiles }),
      pushed: false,
    };
  }

  private async handleValidationFailure(
    pr: DependabotPR,
    config: BatchConfig,
    integrationBranch: string,
    validation: ValidationOutcome,
    preMergeSha: string,
  ): Promise<{ result: PRResult; pushed: boolean }> {
    core.warning(`PR #${pr.number} validation FAIL (exit ${validation.exitCode})`);

    let agentGaveUp: AgentGaveUp | undefined;
    if (config.agenticResolve) {
      const resolution = await this.resolver.resolveValidation({ pr, validation });
      if (resolution.kind === 'resolved') {
        const agentAttempt: AgentAttempt = {
          commitSha: resolution.commitSha,
          summary: resolution.summary,
          outputTail: resolution.outputTail,
        };
        const revalidation = await this.validator.run();
        if (revalidation.passed) {
          return this.validateAndPush(pr, integrationBranch, revalidation, agentAttempt);
        }
        core.warning(`PR #${pr.number}: agent validation fix did not pass revalidation, discarding`);
        if (config.onFailure === 'revert-commit') {
          await this.merger.revertRange(preMergeSha, pr);
        } else {
          await this.merger.resetTo(preMergeSha);
        }
        const explanation = await this.analyzer.explain({ pr, validation: revalidation });
        core.info(`PR #${pr.number} categorized as ${explanation.category} — ${explanation.cause}`);
        const pushed = await this.pushIfRevertCommit(config, integrationBranch, pr);
        return {
          result: this.toPrResult(pr, { kind: 'validation-failed', explanation, pushed }, agentAttempt),
          pushed,
        };
      }
      core.warning(`PR #${pr.number}: agent gave up on validation fix: ${resolution.reason}`);
      agentGaveUp = {
        stage: 'validation',
        reason: resolution.reason,
        outputTail: resolution.outputTail,
      };
    }

    const explanation = await this.analyzer.explain({ pr, validation });
    core.info(`PR #${pr.number} categorized as ${explanation.category} — ${explanation.cause}`);
    await this.merger.dropLastMerge(config.onFailure, pr);
    const pushed = await this.pushIfRevertCommit(config, integrationBranch, pr);
    return {
      result: this.toPrResult(pr, { kind: 'validation-failed', explanation, pushed }, undefined, agentGaveUp),
      pushed,
    };
  }

  /** Pushes the revert commit just created by dropLastMerge/revertRange, if onFailure calls for one. */
  private async pushIfRevertCommit(
    config: BatchConfig,
    integrationBranch: string,
    pr: DependabotPR,
  ): Promise<boolean> {
    if (config.onFailure !== 'revert-commit') return false;
    const revertPush = await this.branchManager.push(integrationBranch);
    if (revertPush.kind === 'pushed') return true;
    core.warning(`PR #${pr.number} revert push rejected (${revertPush.reason}): ${revertPush.message}`);
    return false;
  }

  private async attemptMerge(pr: DependabotPR): Promise<MergeOutcome> {
    return this.merger.merge(pr);
  }

  private async validateAndPush(
    pr: DependabotPR,
    integrationBranch: string,
    _validation: ValidationOutcome,
    agentAttempt?: AgentAttempt,
  ): Promise<{ result: PRResult; pushed: boolean }> {
    const pushOutcome = await this.branchManager.push(integrationBranch);
    if (pushOutcome.kind === 'pushed') {
      core.info(`PR #${pr.number} PASS${agentAttempt ? ' (agent-assisted)' : ''}`);
      return {
        result: { pr, status: 'PASS', ...(agentAttempt && { agentAttempt }) },
        pushed: true,
      };
    }

    // Push refused (workflow scope / branch protection / other). Roll the
    // merge back so subsequent PRs see a clean integration branch tip,
    // then record the rejection and let the loop continue. A previous
    // version threw here and killed the whole run on the first refusal.
    core.warning(
      `PR #${pr.number} push rejected (${pushOutcome.reason}): ${pushOutcome.message}`,
    );
    await this.merger.dropLastMerge('skip', pr);
    return {
      result: this.toPrResult(
        pr,
        { kind: 'push-rejected', reason: pushOutcome.reason, message: pushOutcome.message },
        agentAttempt,
      ),
      pushed: false,
    };
  }

  private toPrResult(
    pr: DependabotPR,
    outcome: ProcessStepOutcome,
    agentAttempt?: AgentAttempt,
    agentGaveUp?: AgentGaveUp,
  ): PRResult {
    const agentFields = {
      ...(agentAttempt && { agentAttempt }),
      ...(agentGaveUp && { agentGaveUp }),
    };
    switch (outcome.kind) {
      case 'pass':
        return { pr, status: 'PASS', ...agentFields };
      case 'merge-conflict':
        return {
          pr,
          status: 'FAIL',
          failure: { kind: 'merge-conflict', files: outcome.files },
          ...agentFields,
        };
      case 'push-rejected':
        return {
          pr,
          status: 'FAIL',
          failure: {
            kind: 'push-rejected',
            reason: outcome.reason,
            message: outcome.message,
          },
          ...agentFields,
        };
      case 'validation-failed':
        return {
          pr,
          status: 'FAIL',
          failure: {
            kind: 'validation-failed',
            category: outcome.explanation.category,
            categoryLabel: outcome.explanation.categoryLabel,
            cause: outcome.explanation.cause,
            exitCode: outcome.explanation.exitCode,
            summary: outcome.explanation.summary,
            details: outcome.explanation.body,
          },
          ...agentFields,
        };
    }
  }

  private placeholderBody(
    integrationBranch: string,
    config: BatchConfig,
    candidateCount: number,
  ): string {
    const initialBody = this.reporter.build({
      integrationBranch,
      baseBranch: config.baseBranch,
      results: [],
    });
    return candidateCount === 0
      ? initialBody
      : `${initialBody}\n\n_Processing ${candidateCount} PR(s)…_`;
  }

  private async openBatchPr(
    integrationBranch: string,
    config: BatchConfig,
  ): Promise<BatchPRRef> {
    return this.prWriter.createPr({
      head: integrationBranch,
      base: config.baseBranch,
      title: `chore(deps): batch Dependabot updates (${integrationBranch})`,
      body: this.placeholderBody(integrationBranch, config, 0),
      draft: true,
    });
  }
}
