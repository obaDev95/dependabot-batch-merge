import { describe, expect, it, vi } from 'vitest';
import { ClaudeAgenticResolver } from '../src/resolve/claude-resolver';
import type { GitRunner } from '../src/git/git-runner';
import type { DependabotPR, ValidationOutcome } from '../src/types';

const pr: DependabotPR = {
  number: 42,
  title: 'bump lodash',
  headRef: 'deps/lodash',
  headSha: 'sha1',
  htmlUrl: 'https://github.com/a/b/pull/42',
  createdAt: '2026-01-01T00:00:00Z',
};

const validation: ValidationOutcome = {
  passed: false,
  exitCode: 1,
  stdoutTail: 'test failed',
  stderrTail: 'error TS2322',
};

function makeGit(shas: string[]): GitRunner {
  let call = 0;
  return {
    run: vi.fn().mockImplementation(() => {
      const sha = shas[call] ?? shas[shas.length - 1]!;
      call++;
      return Promise.resolve({ exitCode: 0, stdout: sha + '\n', stderr: '' });
    }),
    configureIdentity: vi.fn(),
  } as unknown as GitRunner;
}

describe('ClaudeAgenticResolver', () => {
  it('returns resolved when agent commits a new SHA', async () => {
    const git = makeGit(['aaa', 'bbb']); // pre=aaa, post=bbb
    const spawnFn = vi.fn().mockResolvedValue({ output: 'Fixed the type error', timedOut: false, exitCode: 0 });

    const resolver = new ClaudeAgenticResolver('test-key', git, 10_000, spawnFn);
    const result = await resolver.resolveValidation({ pr, validation });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.commitSha).toBe('bbb');
      expect(result.summary).toBe('Fixed the type error');
    }
    expect(spawnFn).toHaveBeenCalledOnce();
    const [args, env] = spawnFn.mock.calls[0] as [string[], NodeJS.ProcessEnv, number];
    expect(args[0]).toBe('-p');
    expect(env['ANTHROPIC_API_KEY']).toBe('test-key');
  });

  it('returns gave-up when agent exits without committing', async () => {
    const git = makeGit(['aaa', 'aaa']); // SHA unchanged
    const spawnFn = vi.fn().mockResolvedValue({ output: 'I cannot fix this', timedOut: false, exitCode: 0 });

    const resolver = new ClaudeAgenticResolver('key', git, 10_000, spawnFn);
    const result = await resolver.resolveConflict({ pr, conflictedFiles: ['package.json'] });

    expect(result.kind).toBe('gave-up');
    if (result.kind === 'gave-up') {
      expect(result.reason).toContain('no commits');
    }
  });

  it('returns gave-up when agent times out', async () => {
    const git = makeGit(['aaa', 'aaa']);
    const spawnFn = vi.fn().mockResolvedValue({ output: '', timedOut: true, exitCode: 0 });

    const resolver = new ClaudeAgenticResolver('key', git, 10_000, spawnFn);
    const result = await resolver.resolveValidation({ pr, validation });

    expect(result.kind).toBe('gave-up');
    if (result.kind === 'gave-up') {
      expect(result.reason).toContain('timed out');
    }
  });

  it('includes conflicted file list in the conflict prompt', async () => {
    const git = makeGit(['aaa', 'bbb']);
    const spawnFn = vi.fn().mockResolvedValue({ output: 'done', timedOut: false, exitCode: 0 });

    const resolver = new ClaudeAgenticResolver('key', git, 10_000, spawnFn);
    await resolver.resolveConflict({ pr, conflictedFiles: ['package.json', 'package-lock.json'] });

    const [args] = spawnFn.mock.calls[0] as [string[], NodeJS.ProcessEnv, number];
    expect(args[1]).toContain('package.json');
    expect(args[1]).toContain('package-lock.json');
  });
});
