import { describe, expect, it, vi } from 'vitest';
import { ClaudeFailureAnalyzer } from '../src/analysis/claude-analyzer';
import { StaticFailureAnalyzer } from '../src/analysis/analyzer';
import type { FailureAnalyzerInput } from '../src/analysis/analyzer';
import type { DependabotPR, ValidationOutcome } from '../src/types';

function makeInput(overrides: Partial<ValidationOutcome> = {}): FailureAnalyzerInput {
  const pr: DependabotPR = {
    number: 1,
    title: 'bump foo',
    headRef: 'deps/foo',
    headSha: 'abc',
    htmlUrl: 'https://github.com/a/b/pull/1',
    createdAt: '2026-01-01T00:00:00Z',
  };
  const validation: ValidationOutcome = {
    passed: false,
    exitCode: 1,
    stdoutTail: 'stdout tail',
    stderrTail: 'error TS2345: some type error',
    ...overrides,
  };
  return { pr, validation };
}

describe('ClaudeFailureAnalyzer', () => {
  it('returns explanation from Claude API response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [{ type: 'text', text: 'Root cause: type mismatch in foo.\nSuggested fix: update call site.' }],
        }),
    });

    const analyzer = new ClaudeFailureAnalyzer({ apiKey: 'test-key', fetchImpl: fetchMock });
    const result = await analyzer.explain(makeInput());

    expect(result.category).toBe('type-error');
    expect(result.summary).toBe('Root cause: type mismatch in foo.');
    expect(result.body).toContain('Suggested fix');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('anthropic.com');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
  });

  it('falls back to static analyzer when Claude API fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('server error') });

    const analyzer = new ClaudeFailureAnalyzer({ apiKey: 'key', fetchImpl: fetchMock });
    const result = await analyzer.explain(makeInput());

    // Should fall back — static analyzer still returns a valid explanation
    expect(result.category).toBeDefined();
    expect(result.cause).toBeDefined();
  });

  it('falls back when response has no text block', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'image' }] }),
    });

    const staticFallback = new StaticFailureAnalyzer();
    const spy = vi.spyOn(staticFallback, 'explain');
    const analyzer = new ClaudeFailureAnalyzer({ apiKey: 'key', fetchImpl: fetchMock, fallback: staticFallback });
    await analyzer.explain(makeInput());

    expect(spy).toHaveBeenCalledOnce();
  });

  it('includes PR context in the prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: 'explanation' }] }),
    });

    const analyzer = new ClaudeFailureAnalyzer({ apiKey: 'k', fetchImpl: fetchMock });
    await analyzer.explain(makeInput());

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toContain('PR: #1');
    expect(body.messages[0].content).toContain('bump foo');
  });
});
