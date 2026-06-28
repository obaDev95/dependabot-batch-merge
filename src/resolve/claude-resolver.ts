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
    // stdin must be closed: with an open stdin pipe the headless agent waits for
    // input that never comes and hangs until the timeout kill (empty output).
    const child = spawn('claude', args, { env, timeout: timeoutMs, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
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
    private readonly apiKey: string | undefined,
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

    // ponytail: no key => subscription mode. Strip any inherited key so the CLI
    // falls back to the claude.ai login instead of a dead/over-quota corporate key.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.apiKey) env.ANTHROPIC_API_KEY = this.apiKey;
    else delete env.ANTHROPIC_API_KEY;
    // Stream the agent's events (stream-json requires --verbose) so a slow or
    // timed-out run still leaves a diagnostic tail. Plain `-p` only prints the
    // final text, so a kill-on-timeout captured nothing — which is exactly when
    // we most need to see what the agent was stuck on.
    const { output, timedOut, exitCode } = await this.spawnFn(
      ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
      env,
      this.timeoutMs,
    );

    const outputTail = tail(output);

    if (timedOut) {
      core.warning(`PR #${prNumber}: agent timed out after ${this.timeoutMs}ms`);
      logOutputTail(prNumber, outputTail);
      return { kind: 'gave-up', reason: `timed out after ${this.timeoutMs}ms`, outputTail };
    }

    const postSha = await this.currentSha();
    if (postSha === preSha) {
      const reason = exitCode === 0 ? 'agent made no commits' : `agent exited ${exitCode} without committing`;
      core.warning(`PR #${prNumber}: ${reason}`);
      logOutputTail(prNumber, outputTail);
      return { kind: 'gave-up', reason, outputTail };
    }

    core.info(`PR #${prNumber}: agent committed fix at ${postSha.slice(0, 7)}`);
    return {
      kind: 'resolved',
      commitSha: postSha,
      summary: `Agent resolved ${kind} fix`,
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

// Dump the agent's tail to stderr (safe in MCP stdio mode, since stdout is the
// JSON-RPC channel) so the operator can see it live, before the structured
// response is returned at end-of-batch.
function logOutputTail(prNumber: number, outputTail: string): void {
  if (!outputTail) return;
  console.error(`[agent #${prNumber} tail begin]\n${outputTail}\n[agent #${prNumber} tail end]`);
}
