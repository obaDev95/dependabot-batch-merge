import { describe, expect, it } from 'vitest';
import { ReportBuilder } from '../src/report/builder';
import type { DependabotPR, PRResult } from '../src/types';

function makePr(number: number): DependabotPR {
  return {
    number,
    title: `bump pkg ${number}`,
    headRef: `dependabot/${number}`,
    headSha: 'abc',
    htmlUrl: `https://github.com/acme/app/pull/${number}`,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('ReportBuilder', () => {
  const builder = new ReportBuilder();

  it('groups failures by category in the report body', () => {
    const results: PRResult[] = [
      {
        pr: makePr(1),
        status: 'FAIL',
        failure: {
          kind: 'validation-failed',
          category: 'npm-auth-401',
          categoryLabel: 'npm 401 (auth missing)',
          cause: 'no token',
          exitCode: 1,
          summary: 'no token',
          details: 'details 1',
        },
      },
      {
        pr: makePr(2),
        status: 'FAIL',
        failure: {
          kind: 'validation-failed',
          category: 'npm-auth-401',
          categoryLabel: 'npm 401 (auth missing)',
          cause: 'no token',
          exitCode: 1,
          summary: 'no token',
          details: 'details 2',
        },
      },
      { pr: makePr(3), status: 'FAIL', failure: { kind: 'merge-conflict', files: ['package-lock.json'] } },
    ];

    const body = builder.build({
      integrationBranch: 'chore/batch-2026-06-09',
      baseBranch: 'main',
      results,
    });

    expect(body).toContain('### npm 401 (auth missing) — 2 PR(s)');
    expect(body).toContain('### merge conflict — 1 PR(s)');
    expect(body).toContain('| npm 401 (auth missing) | 2 |');
  });

  it('round-trips PASSed PR numbers via the machine-readable block', () => {
    const body = builder.build({
      integrationBranch: 'b',
      baseBranch: 'main',
      results: [
        { pr: makePr(11), status: 'PASS' },
        { pr: makePr(12), status: 'FAIL', failure: { kind: 'merge-conflict', files: ['x'] } },
        { pr: makePr(13), status: 'PASS' },
      ],
    });

    expect(ReportBuilder.parsePassedPrNumbers(body)).toEqual([11, 13]);
  });

  it('includes final suite section when provided', () => {
    const body = builder.build({
      integrationBranch: 'b',
      baseBranch: 'main',
      results: [{ pr: makePr(1), status: 'PASS' }],
      finalSuite: { passed: false, exitCode: 2, stdoutTail: '', stderrTail: 'final fail' },
    });

    expect(body).toContain('## Final suite re-run');
    expect(body).toContain('final fail');
  });
});
