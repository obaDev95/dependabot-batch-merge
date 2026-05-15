import type { DependabotPR } from '../types';
import type { GitHubClient } from './client';

type ListedPR = {
  number: number;
  title: string;
  head: { ref: string; sha: string };
  html_url: string;
  created_at: string;
  user: { login: string } | null;
};

export class DependabotPRLister {
  constructor(private readonly gh: GitHubClient) {}

  async extractOpenPullRequests(author: string, max: number): Promise<DependabotPR[]> {
    const allOpenPrs = await this.gh.octokit.paginate(this.gh.octokit.rest.pulls.list, {
      owner: this.gh.owner,
      repo: this.gh.repo,
      state: 'open',
      sort: 'created',
      direction: 'asc',
      per_page: 100,
    });

    return this.filterByAuthor(allOpenPrs, author).slice(0, max).map(toDependabotPR);
  }

  private filterByAuthor<T extends ListedPR>(prs: T[], author: string): T[] {
    const expected = author.toLowerCase();
    return prs.filter((pr) => pr.user?.login.toLowerCase() === expected);
  }
}

function toDependabotPR(pr: ListedPR): DependabotPR {
  return {
    number: pr.number,
    title: pr.title,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    htmlUrl: pr.html_url,
    createdAt: pr.created_at,
  };
}
