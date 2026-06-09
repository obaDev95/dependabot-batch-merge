import * as exec from '@actions/exec';

export interface GitOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class GitRunner {
  async run(args: string[], opts: { ignoreReturnCode?: boolean } = {}): Promise<GitOutput> {
    let stdout = '';
    let stderr = '';
    const exitCode = await exec.exec('git', args, {
      ignoreReturnCode: opts.ignoreReturnCode ?? false,
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
      exitCode,
      stdout,
      stderr,
    };
  }

  async configureIdentity(name: string, email: string): Promise<void> {
    await this.run(['config', 'user.name', name]);
    await this.run(['config', 'user.email', email]);
  }
}
