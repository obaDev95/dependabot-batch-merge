import * as core from '@actions/core';
import type { FailureAnalyzer } from './analysis/analyzer';
import type { BranchManager } from './git/branch-manager';
import type { PRMerger } from './git/merger';
import type { DependabotPRLister } from './github/pr-lister';
import type { BatchPRRef, BatchPRWriter } from './github/pr-writer';
import type { SourcePRCloser } from './github/source-pr-closer';
import type { ReportBuilder } from './report/builder';
import type {
  BatchConfig,
  BatchSummary,
  DependabotPR,
  PRResult,
  ValidationOutcome,
} from './types';
import type { ValidationRunner } from './validation/command-runner';

export class BatchOrchestrator {
  constructor(
    private readonly prLister: DependabotPRLister,
    private readonly branchManager: BranchManager,
    private readonly merger: PRMerger,
    private readonly validator: ValidationRunner,
    private readonly analyzer: FailureAnalyzer,
    private readonly reporter: ReportBuilder,
    private readonly prWriter: BatchPRWriter,
    private readonly sourcePrCloser: SourcePRCloser,
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

    for (const pr of candidates) {
      core.startGroup(`Processing PR #${pr.number} — ${pr.title}`);
      const { result, pushed } = await this.processPr(pr, config, integrationBranch);
      results.push(result);

      if (pushed && !batchPr) {
        batchPr = await this.openBatchPr(integrationBranch, config);
      }
      if (batchPr) {
        await this.prWriter.updatePrBody(
          batchPr.number,
          this.reporter.build({
            integrationBranch,
            baseBranch: config.baseBranch,
            results,
          }),
        );
      }
      core.endGroup();
    }

    let finalSuite: ValidationOutcome | undefined;
    if (config.reRunFinalSuite && results.some((r) => r.status === 'PASS')) {
      core.info('Running final validation on integration branch tip');
      finalSuite = await this.validator.run();
    }

    if (batchPr) {
      await this.prWriter.updatePrBody(
        batchPr.number,
        this.reporter.build({
          integrationBranch,
          baseBranch: config.baseBranch,
          results,
          finalSuite,
        }),
      );
      if (!config.draftPr) {
        await this.prWriter.markPrAsReady(batchPr.number);
      }
      if (config.closeSourcePrs) {
        await this.closePassedSourcePrs(results, batchPr.number);
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

  private async processPr(
    pr: DependabotPR,
    config: BatchConfig,
    integrationBranch: string,
  ): Promise<{ result: PRResult; pushed: boolean }> {
    await this.branchManager.fetchPr(pr.headRef);

    const mergeOutcome = await this.merger.merge(pr);
    if (mergeOutcome.kind === 'conflict') {
      core.warning(`Merge conflict for PR #${pr.number}`);
      return {
        result: {
          pr,
          status: 'FAIL',
          failure: { kind: 'merge-conflict', files: mergeOutcome.conflictedFiles ?? [] },
        },
        pushed: false,
      };
    }

    const validation = await this.validator.run();
    if (validation.passed) {
      const pushOutcome = await this.branchManager.push(integrationBranch);
      if (pushOutcome.kind === 'pushed') {
        core.info(`PR #${pr.number} PASS`);
        return { result: { pr, status: 'PASS' }, pushed: true };
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
        result: {
          pr,
          status: 'FAIL',
          failure: {
            kind: 'push-rejected',
            reason: pushOutcome.reason,
            message: pushOutcome.message,
          },
        },
        pushed: false,
      };
    }

    core.warning(`PR #${pr.number} validation FAIL (exit ${validation.exitCode})`);
    const explanation = await this.analyzer.explain({ pr, validation });
    core.info(`PR #${pr.number} categorized as ${explanation.category} — ${explanation.cause}`);
    await this.merger.dropLastMerge(config.onFailure, pr);
    let pushed = false;
    if (config.onFailure === 'revert-commit') {
      const revertPush = await this.branchManager.push(integrationBranch);
      if (revertPush.kind === 'pushed') {
        pushed = true;
      } else {
        core.warning(
          `PR #${pr.number} revert push rejected (${revertPush.reason}): ${revertPush.message}`,
        );
      }
    }
    return {
      result: {
        pr,
        status: 'FAIL',
        failure: {
          kind: 'validation-failed',
          category: explanation.category,
          categoryLabel: explanation.categoryLabel,
          cause: explanation.cause,
          exitCode: explanation.exitCode,
          summary: explanation.summary,
          details: explanation.body,
        },
      },
      pushed,
    };
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

  private async closePassedSourcePrs(
    results: PRResult[],
    batchPrNumber: number,
  ): Promise<void> {
    const passed = results.filter((r) => r.status === 'PASS');
    if (passed.length === 0) return;
    core.info(`Closing ${passed.length} source PR(s) bundled into batch PR #${batchPrNumber}`);
    for (const r of passed) {
      try {
        await this.sourcePrCloser.closeAsBundled(r.pr.number, batchPrNumber);
        core.info(`Closed source PR #${r.pr.number}`);
      } catch (err) {
        // Individual close failures (already closed, permissions, etc.) are
        // recoverable — the batch PR is already up. Warn and keep going so a
        // single stale PR doesn't block the rest from being closed.
        core.warning(`Failed to close source PR #${r.pr.number}: ${(err as Error).message}`);
      }
    }
  }
}
