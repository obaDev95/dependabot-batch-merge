import * as github from '@actions/github';
export type Octokit = ReturnType<typeof github.getOctokit>;

export class GitHubClient {
  readonly owner: string;
  readonly repo: string;
  readonly octokit: Octokit;

  constructor(token: string, owner: string, repo: string) {
    this.octokit = github.getOctokit(token);
    this.owner = owner;
    this.repo = repo;
  }
}
