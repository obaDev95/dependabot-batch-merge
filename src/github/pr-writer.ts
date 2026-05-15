import type { GitHubClient } from './client';

export interface BatchPRRef {
  number: number;
  url: string;
}

export interface CreatePRParams {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export class BatchPRWriter {
  constructor(private readonly gh: GitHubClient) {}

  async findExistingPr(head: string, base: string): Promise<BatchPRRef | null> {
    const { data } = await this.gh.octokit.rest.pulls.list({
      owner: this.gh.owner,
      repo: this.gh.repo,
      state: 'open',
      head: `${this.gh.owner}:${head}`,
      base,
      per_page: 1,
    });

    const [existingPR] = data;

    if (existingPR) {
      return {
        number: existingPR.number,
        url: existingPR.html_url,
      };
    }

    return null;
  }

  async createPr(params: CreatePRParams): Promise<BatchPRRef> {
    const { data } = await this.gh.octokit.rest.pulls.create({
      owner: this.gh.owner,
      repo: this.gh.repo,
      head: params.head,
      base: params.base,
      title: params.title,
      body: params.body,
      draft: params.draft,
    });
    return { number: data.number, url: data.html_url };
  }

  async updatePrBody(prNumber: number, body: string): Promise<void> {
    await this.gh.octokit.rest.pulls.update({
      owner: this.gh.owner,
      repo: this.gh.repo,
      pull_number: prNumber,
      body,
    });
  }

  async markPrAsReady(prNumber: number): Promise<void> {
    const { data } = await this.gh.octokit.rest.pulls.get({
      owner: this.gh.owner,
      repo: this.gh.repo,
      pull_number: prNumber,
    });
    if (!data.draft || !data.node_id) return;

    await this.gh.octokit.graphql(
      `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`,
      { id: data.node_id },
    );
  }
}
