import * as exec from '@actions/exec';
import type { ValidationOutcome } from '../types';

const TAIL_BYTES = 8000;

export interface ValidationRunner {
  run(): Promise<ValidationOutcome>;
}

export class CommandValidationRunner implements ValidationRunner {
  constructor(private readonly command: string) {}

  async run(): Promise<ValidationOutcome> {
    let stdout = '';
    let stderr = '';
    const exitCode = await exec.exec('bash', ['-lc', this.command], {
      ignoreReturnCode: true,
      listeners: {
        stdout: (data) => {
          stdout += data.toString();
        },
        stderr: (data) => {
          stderr += data.toString();
        },
      },
    });

    return {
      passed: exitCode === 0,
      exitCode,
      stdoutTail: tail(stdout, TAIL_BYTES),
      stderrTail: tail(stderr, TAIL_BYTES),
    };
  }
}

function tail(text: string, bytes: number): string {
  if (text.length <= bytes) return text;
  return `…(truncated)…\n${text.slice(-bytes)}`;
}
