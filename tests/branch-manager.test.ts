import { describe, expect, it } from 'vitest';
import { BranchManager } from '../src/git/branch-manager';
import type { GitOutput, GitRunner } from '../src/git/git-runner';

class FakeGitRunner implements GitRunner {
  readonly calls: string[][] = [];
  private readonly responses = new Map<string, GitOutput>();

  queue(args: string[], output: GitOutput): void {
    this.responses.set(args.join('\0'), output);
  }

  async run(args: string[], _opts?: { ignoreReturnCode?: boolean }): Promise<GitOutput> {
    this.calls.push(args);
    return (
      this.responses.get(args.join('\0')) ?? {
        exitCode: 0,
        stdout: '',
        stderr: '',
      }
    );
  }

  async configureIdentity(_name: string, _email: string): Promise<void> {}
}

describe('BranchManager.push', () => {
  it('returns pushed on exit 0', async () => {
    const git = new FakeGitRunner();
    git.queue(['push', 'origin', 'branch'], { exitCode: 0, stdout: '', stderr: '' });
    const manager = new BranchManager(git);

    const result = await manager.push('branch');

    expect(result).toEqual({ kind: 'pushed' });
  });

  it('detects workflow scope rejection', async () => {
    const git = new FakeGitRunner();
    git.queue(['push', 'origin', 'branch'], {
      exitCode: 1,
      stdout: '',
      stderr: 'refusing to allow a Personal Access Token to create or update workflow',
    });
    const manager = new BranchManager(git);

    const result = await manager.push('branch');

    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('workflow-scope-required');
    }
  });

  it('detects branch protection rejection', async () => {
    const git = new FakeGitRunner();
    git.queue(['push', 'origin', 'branch'], {
      exitCode: 1,
      stdout: 'GH006: Protected branch update failed',
      stderr: '',
    });
    const manager = new BranchManager(git);

    const result = await manager.push('branch');

    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('branch-protection');
    }
  });

  it('returns other rejection for unrecognized errors', async () => {
    const git = new FakeGitRunner();
    git.queue(['push', 'origin', 'branch'], {
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: remote rejected',
    });
    const manager = new BranchManager(git);

    const result = await manager.push('branch');

    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('other');
      expect(result.message).toContain('remote rejected');
    }
  });
});
