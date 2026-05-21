import * as core from '@actions/core';
import type { FailureExplanation } from '../types';
import {
  StaticFailureAnalyzer,
  type FailureAnalyzer,
  type FailureAnalyzerInput,
} from './analyzer';
import { categorizeFailure } from './categorize';

// NOTE: The exact Cursor Cloud / Background Agents API surface should be confirmed against
// https://docs.cursor.com before relying on this in production. This implementation targets
// a generic JSON endpoint that accepts a prompt and returns a text response. If the live API
// shape differs, only `callCursor` below needs to change — the rest of the orchestration is
// already insulated behind the FailureAnalyzer interface.
const DEFAULT_ENDPOINT = 'https://api.cursor.com/v0/agents/runs';

export interface CursorAnalyzerOptions {
  apiKey: string;
  endpoint?: string;
  fallback?: FailureAnalyzer;
  fetchImpl?: typeof fetch;
}

export class CursorFailureAnalyzer implements FailureAnalyzer {
  private readonly fallback: FailureAnalyzer;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: CursorAnalyzerOptions) {
    this.fallback = opts.fallback ?? new StaticFailureAnalyzer();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async explain(input: FailureAnalyzerInput): Promise<FailureExplanation> {
    const { category, label, cause } = categorizeFailure(input.validation);
    try {
      const text = await this.callCursor(this.buildPrompt(input));
      return {
        category,
        categoryLabel: label,
        cause,
        exitCode: input.validation.exitCode,
        summary: firstLine(text) || cause,
        body: text,
      };
    } catch (err) {
      core.warning(`Cursor analyzer failed, using fallback: ${(err as Error).message}`);
      return this.fallback.explain(input);
    }
  }

  private buildPrompt({ pr, validation }: FailureAnalyzerInput): string {
    return [
      `A Dependabot pull request was merged into an integration branch and the validation suite failed.`,
      ``,
      `PR: #${pr.number} — ${pr.title}`,
      `URL: ${pr.htmlUrl}`,
      `Exit code: ${validation.exitCode}`,
      ``,
      `Tail of stderr:`,
      '```',
      validation.stderrTail || '(empty)',
      '```',
      ``,
      `Tail of stdout:`,
      '```',
      validation.stdoutTail || '(empty)',
      '```',
      ``,
      `Write a concise explanation (under 200 words) of the most likely root cause and the suggested next step. ` +
        `Begin with a one-line summary suitable as the first line of a Markdown report.`,
    ].join('\n');
  }

  private async callCursor(prompt: string): Promise<string> {
    const endpoint = this.opts.endpoint ?? DEFAULT_ENDPOINT;
    const res = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({ prompt }),
    });

    if (!res.ok) {
      throw new Error(`Cursor API responded ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as { text?: string; output?: string; message?: string };
    const text = json.text ?? json.output ?? json.message;
    if (!text) {
      throw new Error('Cursor API response missing text/output/message field');
    }
    return text;
  }
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text.trim() : text.slice(0, idx).trim();
}
