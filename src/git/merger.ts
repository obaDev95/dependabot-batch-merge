import type { DependabotPR, FailureHandling, MergeOutcome } from '../types';
import type { GitRunner } from './git-runner';

export class PRMerger {
  constructor(private readonly git: GitRunner) {}

  async merge(pr: DependabotPR): Promise<MergeOutcome> {
    const result = await this.git.run(
      ['merge', '--no-ff', '-m', this.mergeMessage(pr), pr.headSha],
      { ignoreReturnCode: true },
    );

    if (result.exitCode === 0) {
      return { kind: 'merged' };
    }

    const conflictedFiles = await this.detectConflicts();
    // ponytail: caller decides abort vs. agent resolution — don't abort here
    return { kind: 'conflict', conflictedFiles };
  }

  async abortMerge(): Promise<void> {
    await this.git.run(['merge', '--abort'], { ignoreReturnCode: true });
  }

  async headSha(): Promise<string> {
    const result = await this.git.run(['rev-parse', 'HEAD']);
    return result.stdout.trim();
  }

  async resetTo(sha: string): Promise<void> {
    await this.git.run(['reset', '--hard', sha]);
  }

  async dropLastMerge(mode: FailureHandling, pr: DependabotPR): Promise<void> {
    if (mode === 'skip') {
      await this.git.run(['reset', '--hard', 'HEAD~1']);
      return;
    }
    await this.git.run([
      'revert',
      '--no-edit',
      '-m',
      '1',
      '-m',
      `Revert merge of #${pr.number} (validation failed)`,
      'HEAD',
    ]);
  }

  private async detectConflicts(): Promise<string[]> {
    const result = await this.git.run(['diff', '--name-only', '--diff-filter=U'], {
      ignoreReturnCode: true,
    });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private mergeMessage(pr: DependabotPR): string {
    return `Merge PR #${pr.number}: ${pr.title}`;
  }
}
