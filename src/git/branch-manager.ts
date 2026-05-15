import type { GitRunner } from './git-runner';

export class BranchManager {
  constructor(private readonly git: GitRunner) {}

  async createIntegrationBranch(prefix: string, baseBranch: string): Promise<string> {
    const dateSuffix = new Date().toISOString().slice(0, 10);
    const branch = `${prefix}-${dateSuffix}`;

    await this.git.run(['fetch', 'origin', baseBranch]);
    await this.git.run(['checkout', '-B', branch, `origin/${baseBranch}`]);
    await this.git.run(['push', '-u', 'origin', branch]);
    return branch;
  }

  async push(branch: string): Promise<void> {
    await this.git.run(['push', 'origin', branch]);
  }

  async fetchPr(headRef: string): Promise<void> {
    await this.git.run(['fetch', 'origin', headRef]);
  }
}
