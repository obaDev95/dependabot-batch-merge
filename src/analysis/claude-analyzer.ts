import * as core from '@actions/core';
import type { FailureExplanation } from '../types';
import {
  StaticFailureAnalyzer,
  type FailureAnalyzer,
  type FailureAnalyzerInput,
} from './analyzer';
import { categorizeFailure } from './categorize';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-7';

export interface ClaudeAnalyzerOptions {
  apiKey: string;
  fallback?: FailureAnalyzer;
  fetchImpl?: typeof fetch;
}

export class ClaudeFailureAnalyzer implements FailureAnalyzer {
  private readonly fallback: FailureAnalyzer;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClaudeAnalyzerOptions) {
    this.fallback = opts.fallback ?? new StaticFailureAnalyzer();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async explain(input: FailureAnalyzerInput): Promise<FailureExplanation> {
    const { category, label, cause } = categorizeFailure(input.validation);
    try {
      const text = await this.callClaude(this.buildPrompt(input));
      return {
        category,
        categoryLabel: label,
        cause,
        exitCode: input.validation.exitCode,
        summary: firstLine(text) || cause,
        body: text,
      };
    } catch (err) {
      core.warning(`Claude analyzer failed, using fallback: ${(err as Error).message}`);
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

  private async callClaude(prompt: string): Promise<string> {
    const res = await this.fetchImpl(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Claude API responded ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = json.content?.find((b) => b.type === 'text')?.text;
    if (!text) {
      throw new Error('Claude API response missing text content block');
    }
    return text;
  }
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text.trim() : text.slice(0, idx).trim();
}
