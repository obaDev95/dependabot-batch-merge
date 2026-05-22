import type { GitHubClient } from './client';

export class SourcePRCloser {
  constructor(private readonly gh: GitHubClient) {}

  async closeAsBundled(sourcePrNumber: number, batchPrNumber: number): Promise<void> {
    await this.gh.octokit.rest.issues.createComment({
      owner: this.gh.owner,
      repo: this.gh.repo,
      issue_number: sourcePrNumber,
      body: `Bundled into batch PR #${batchPrNumber}. The update will land when #${batchPrNumber} merges.`,
    });
    await this.gh.octokit.rest.pulls.update({
      owner: this.gh.owner,
      repo: this.gh.repo,
      pull_number: sourcePrNumber,
      state: 'closed',
    });
  }
}
