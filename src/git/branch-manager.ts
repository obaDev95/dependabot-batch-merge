import type { GitRunner } from './git-runner';

export type PushOutcome =
  | { kind: 'pushed' }
  | {
      kind: 'rejected';
      reason: 'workflow-scope-required' | 'branch-protection' | 'other';
      message: string;
    };

export class BranchManager {
  constructor(private readonly git: GitRunner) {}

  async createIntegrationBranch(prefix: string, baseBranch: string): Promise<string> {
    const dateSuffix = new Date().toISOString().slice(0, 10);
    const branch = `${prefix}-${dateSuffix}`;

    await this.git.run(['fetch', 'origin', baseBranch]);
    await this.git.run(['checkout', '-B', branch, `origin/${baseBranch}`]);
    // Force-push: the integration branch is ephemeral state owned by the action.
    // Same-day re-runs must overwrite any prior remote state without rejection.
    await this.git.run(['push', '-u', '--force', 'origin', branch]);
    return branch;
  }

  // Non-throwing on remote rejection so the orchestrator can record the
  // outcome and continue with the next PR. A previous version let the
  // exception bubble, which killed the whole run on the first workflow-
  // touching Dependabot PR (PAT lacks 'workflow' scope) — leaving the
  // remaining backlog unprocessed.
  async push(branch: string): Promise<PushOutcome> {
    const result = await this.git.run(['push', 'origin', branch], { ignoreReturnCode: true });
    if (result.exitCode === 0) return { kind: 'pushed' };

    const combined = `${result.stderr}\n${result.stdout}`;
    if (
      /refusing to allow a (?:Personal Access Token|GitHub App) to (?:create or update workflow|workflow)/i.test(
        combined,
      )
    ) {
      return {
        kind: 'rejected',
        reason: 'workflow-scope-required',
        message:
          "GitHub refused the push because the PR modifies .github/workflows/* and the PAT lacks the 'workflow' scope (classic) or 'Actions: Write' permission (fine-grained).",
      };
    }
    if (/protected branch|branch protection|GH006/i.test(combined)) {
      return {
        kind: 'rejected',
        reason: 'branch-protection',
        message:
          'GitHub refused the push due to branch protection rules on the integration branch.',
      };
    }
    return {
      kind: 'rejected',
      reason: 'other',
      message: combined.trim() || `git push exited with code ${result.exitCode}`,
    };
  }

  async fetchPr(headRef: string): Promise<void> {
    await this.git.run(['fetch', 'origin', headRef]);
  }
}
