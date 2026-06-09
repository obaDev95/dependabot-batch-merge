import { describe, expect, it, vi } from 'vitest';
import * as exec from '@actions/exec';
import { CommandValidationRunner } from '../src/validation/command-runner';

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
}));

describe('CommandValidationRunner', () => {
  it('captures exit code and tails long output', async () => {
    const longStdout = 'x'.repeat(9000);
    vi.mocked(exec.exec).mockImplementation(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from(longStdout));
      return 1;
    });

    const runner = new CommandValidationRunner('npm test');
    const result = await runner.run();

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdoutTail).toContain('(truncated)');
    expect(result.stdoutTail.length).toBeLessThan(longStdout.length);
  });

  it('reports passed when exit code is 0', async () => {
    vi.mocked(exec.exec).mockResolvedValue(0);

    const runner = new CommandValidationRunner('npm test');
    const result = await runner.run();

    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});
