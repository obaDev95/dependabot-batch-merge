import * as core from '@actions/core';
import type { FailureAnalyzer } from './analysis/analyzer';
import type { BranchManager } from './git/branch-manager';
import type { PRMerger } from './git/merger';
import type { DependabotPRLister } from './github/pr-lister';
import type { BatchPRRef, BatchPRWriter } from './github/pr-writer';
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

    const batchPr = await this.openInitialBatchPr(integrationBranch, config, candidates.length);
    const results: PRResult[] = [];

    for (const pr of candidates) {
      core.startGroup(`Processing PR #${pr.number} — ${pr.title}`);
      const result = await this.processPr(pr, config, integrationBranch);
      results.push(result);
      await this.prWriter.updatePrBody(
        batchPr.number,
        this.reporter.build({
          integrationBranch,
          baseBranch: config.baseBranch,
          results,
        }),
      );
      core.endGroup();
    }

    let finalSuite: ValidationOutcome | undefined;
    if (config.reRunFinalSuite && results.some((r) => r.status === 'PASS')) {
      core.info('Running final validation on integration branch tip');
      finalSuite = await this.validator.run();
    }

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

    return {
      batchPrNumber: batchPr.number,
      batchPrUrl: batchPr.url,
      results,
      ...(finalSuite && {
        finalSuite,
      }),
    };
  }

  private async processPr(
    pr: DependabotPR,
    config: BatchConfig,
    integrationBranch: string,
  ): Promise<PRResult> {
    await this.branchManager.fetchPr(pr.headRef);

    const mergeOutcome = await this.merger.merge(pr);
    if (mergeOutcome.kind === 'conflict') {
      core.warning(`Merge conflict for PR #${pr.number}`);
      return {
        pr,
        status: 'FAIL',
        failure: { kind: 'merge-conflict', files: mergeOutcome.conflictedFiles ?? [] },
      };
    }

    const validation = await this.validator.run();
    if (validation.passed) {
      await this.branchManager.push(integrationBranch);
      core.info(`PR #${pr.number} PASS`);
      return { pr, status: 'PASS' };
    }

    core.warning(`PR #${pr.number} validation FAIL (exit ${validation.exitCode})`);
    const explanation = await this.analyzer.explain({ pr, validation });
    await this.merger.dropLastMerge(config.onFailure, pr);
    if (config.onFailure === 'revert-commit') {
      await this.branchManager.push(integrationBranch);
    }
    return {
      pr,
      status: 'FAIL',
      failure: {
        kind: 'validation-failed',
        summary: explanation.summary,
        details: explanation.body,
      },
    };
  }

  private async openInitialBatchPr(
    integrationBranch: string,
    config: BatchConfig,
    candidateCount: number,
  ): Promise<BatchPRRef> {
    const initialBody = this.reporter.build({
      integrationBranch,
      baseBranch: config.baseBranch,
      results: [],
    });
    const placeholderBody =
      candidateCount === 0
        ? initialBody
        : `${initialBody}\n\n_Processing ${candidateCount} PR(s)…_`;

    const existing = await this.prWriter.findExistingPr(integrationBranch, config.baseBranch);
    if (existing) {
      await this.prWriter.updatePrBody(existing.number, placeholderBody);
      return existing;
    }

    return this.prWriter.createPr({
      head: integrationBranch,
      base: config.baseBranch,
      title: `chore(deps): batch Dependabot updates (${integrationBranch})`,
      body: placeholderBody,
      draft: true,
    });
  }
}
