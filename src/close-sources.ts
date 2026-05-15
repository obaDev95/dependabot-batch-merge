import * as core from '@actions/core';
import type { GitHubClient } from './github/client';
import { ReportBuilder } from './report/builder';
import type { CloseSourcesConfig } from './types';

export interface CloseSourcesSummary {
  batchPrNumber: number;
  closedPrNumbers: number[];
  skippedPrNumbers: number[];
}

export class CloseSourcesOrchestrator {
  constructor(private readonly gh: GitHubClient) {}

  async run(config: CloseSourcesConfig): Promise<CloseSourcesSummary> {
    const batchPr = await this.findMostRecentMergedBatchPr(config);
    if (!batchPr) {
      throw new Error(
        `No merged batch PR found targeting ${config.baseBranch} with head prefix ${config.integrationBranchPrefix}`,
      );
    }
    core.info(`Most recent merged batch PR: #${batchPr.number}`);

    const passedPrs = ReportBuilder.parsePassedPrNumbers(batchPr.body ?? '');
    core.info(`Batch PR records ${passedPrs.length} PASSed source PR(s)`);

    if (!config.closeSourcePrs) {
      core.info('close-source-prs is false — skipping close.');
      return { batchPrNumber: batchPr.number, closedPrNumbers: [], skippedPrNumbers: passedPrs };
    }

    const closed: number[] = [];
    const skipped: number[] = [];
    for (const number of passedPrs) {
      try {
        await this.closeWithComment(number, batchPr.number, batchPr.merge_commit_sha ?? '');
        closed.push(number);
      } catch (err) {
        core.warning(`Failed to close PR #${number}: ${(err as Error).message}`);
        skipped.push(number);
      }
    }

    return { batchPrNumber: batchPr.number, closedPrNumbers: closed, skippedPrNumbers: skipped };
  }

  private async findMostRecentMergedBatchPr(config: CloseSourcesConfig) {
    const candidates = await this.gh.octokit.paginate(this.gh.octokit.rest.pulls.list, {
      owner: this.gh.owner,
      repo: this.gh.repo,
      state: 'closed',
      base: config.baseBranch,
      sort: 'updated',
      direction: 'desc',
      per_page: 50,
    });
    return candidates.find(
      (pr) => pr.merged_at !== null && pr.head.ref.startsWith(config.integrationBranchPrefix),
    );
  }

  private async closeWithComment(
    sourcePrNumber: number,
    batchPrNumber: number,
    mergeCommitSha: string,
  ): Promise<void> {
    const shaSuffix = mergeCommitSha ? ` (merge commit ${mergeCommitSha.slice(0, 7)})` : '';
    await this.gh.octokit.rest.issues.createComment({
      owner: this.gh.owner,
      repo: this.gh.repo,
      issue_number: sourcePrNumber,
      body: `Superseded by #${batchPrNumber}${shaSuffix}. Closing as part of the batch merge workflow.`,
    });
    await this.gh.octokit.rest.pulls.update({
      owner: this.gh.owner,
      repo: this.gh.repo,
      pull_number: sourcePrNumber,
      state: 'closed',
    });
  }
}
