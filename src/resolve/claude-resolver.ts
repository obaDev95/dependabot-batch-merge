import * as core from '@actions/core';
import { spawn } from 'node:child_process';
import type { GitRunner } from '../git/git-runner';
import type { DependabotPR, ValidationOutcome } from '../types';

export type ResolutionOutcome =
  | { kind: 'resolved'; commitSha: string; summary: string; outputTail: string }
  | { kind: 'gave-up'; reason: string; outputTail: string };

export interface AgenticResolver {
  resolveConflict(input: { pr: DependabotPR; conflictedFiles: string[] }): Promise<ResolutionOutcome>;
  resolveValidation(input: { pr: DependabotPR; validation: ValidationOutcome }): Promise<ResolutionOutcome>;
}

export class NoopAgenticResolver implements AgenticResolver {
  async resolveConflict(): Promise<ResolutionOutcome> {
    return { kind: 'gave-up', reason: 'agentic-resolve disabled', outputTail: '' };
  }
  async resolveValidation(): Promise<ResolutionOutcome> {
    return { kind: 'gave-up', reason: 'agentic-resolve disabled', outputTail: '' };
  }
}

type SpawnFn = (
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<{ output: string; timedOut: boolean; exitCode: number }>;

function defaultSpawn(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ output: string; timedOut: boolean; exitCode: number }> {
  return new Promise((resolve) => {
    let output = '';
    // ponytail: explicit cwd so the agent sees the same working tree as the
    // orchestrator's git ops. Inheriting silently works today but breaks the
    // moment anyone introduces a chdir between MCP startup and resolver call.
    const child = spawn('claude', args, { env, timeout: timeoutMs, cwd: process.cwd() });
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => {
      resolve({ output, timedOut: child.killed, exitCode: code ?? 1 });
    });
    child.on('error', (err) => {
      output += `\n[spawn error: ${err.message}]`;
      resolve({ output, timedOut: false, exitCode: 1 });
    });
  });
}

export class ClaudeAgenticResolver implements AgenticResolver {
  private readonly spawnFn: SpawnFn;

  constructor(
    private readonly apiKey: string,
    private readonly git: GitRunner,
    private readonly timeoutMs: number,
    spawnFn?: SpawnFn,
  ) {
    this.spawnFn = spawnFn ?? defaultSpawn;
  }

  async resolveConflict({ pr, conflictedFiles }: { pr: DependabotPR; conflictedFiles: string[] }): Promise<ResolutionOutcome> {
    const prompt = [
      `You are resolving a git merge conflict introduced by a Dependabot dependency update.`,
      ``,
      `PR: #${pr.number} — ${pr.title}`,
      `URL: ${pr.htmlUrl}`,
      ``,
      `The merge is in progress with conflicts in:`,
      conflictedFiles.map((f) => `  - ${f}`).join('\n'),
      ``,
      `Steps:`,
      `1. Resolve all conflict markers, preferring the incoming Dependabot version for dependency lines.`,
      `2. Stage resolved files with git add.`,
      `3. Complete the merge commit with: git commit --no-edit`,
      `4. Do NOT run the validation suite — the orchestrator handles that.`,
    ].join('\n');
    return this.runAgent(prompt, pr.number, 'conflict');
  }

  async resolveValidation({ pr, validation }: { pr: DependabotPR; validation: ValidationOutcome }): Promise<ResolutionOutcome> {
    const prompt = [
      `You are fixing a post-merge validation failure caused by a Dependabot dependency update.`,
      ``,
      `PR: #${pr.number} — ${pr.title}`,
      `URL: ${pr.htmlUrl}`,
      `Exit code: ${validation.exitCode}`,
      ``,
      `Stderr tail:`,
      '```',
      validation.stderrTail || '(empty)',
      '```',
      ``,
      `Stdout tail:`,
      '```',
      validation.stdoutTail || '(empty)',
      '```',
      ``,
      `Steps:`,
      `1. Diagnose the root cause from the output above.`,
      `2. Apply the minimal fix (update type signatures, snapshots, peer deps, imports, etc.).`,
      `3. Commit your changes with a descriptive message.`,
      `4. Do NOT re-run the validation suite — the orchestrator will do that.`,
      ``,
      `If you cannot confidently fix the issue, exit without committing anything.`,
    ].join('\n');
    return this.runAgent(prompt, pr.number, 'validation');
  }

  private async runAgent(prompt: string, prNumber: number, kind: string): Promise<ResolutionOutcome> {
    const preSha = await this.currentSha();
    core.info(`PR #${prNumber}: invoking Claude agent for ${kind} fix (pre: ${preSha.slice(0, 7)})`);

    const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: this.apiKey };
    const { output, timedOut, exitCode } = await this.spawnFn(
      ['-p', prompt, '--dangerously-skip-permissions'],
      env,
      this.timeoutMs,
    );

    const outputTail = tail(output);

    if (timedOut) {
      core.warning(`PR #${prNumber}: agent timed out after ${this.timeoutMs}ms`);
      return { kind: 'gave-up', reason: `timed out after ${this.timeoutMs}ms`, outputTail };
    }

    const postSha = await this.currentSha();
    if (postSha === preSha) {
      const reason = exitCode === 0 ? 'agent made no commits' : `agent exited ${exitCode} without committing`;
      core.warning(`PR #${prNumber}: ${reason}`);
      return { kind: 'gave-up', reason, outputTail };
    }

    core.info(`PR #${prNumber}: agent committed fix at ${postSha.slice(0, 7)}`);
    return {
      kind: 'resolved',
      commitSha: postSha,
      summary: firstLine(output) || `Agent ${kind} fix`,
      outputTail,
    };
  }

  private async currentSha(): Promise<string> {
    const result = await this.git.run(['rev-parse', 'HEAD']);
    return result.stdout.trim();
  }
}

function tail(text: string, bytes = 4000): string {
  if (text.length <= bytes) return text;
  return `…(truncated)…\n${text.slice(-bytes)}`;
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text.trim() : text.slice(0, idx).trim();
}
