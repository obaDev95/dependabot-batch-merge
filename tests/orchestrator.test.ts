import { describe, expect, it, vi } from 'vitest';
import { BatchOrchestrator } from '../src/orchestrator';
import { ReportBuilder } from '../src/report/builder';
import type { FailureAnalyzer } from '../src/analysis/analyzer';
import type { BranchManager } from '../src/git/branch-manager';
import type { PRMerger } from '../src/git/merger';
import type { DependabotPRLister } from '../src/github/pr-lister';
import type { BatchPRWriter } from '../src/github/pr-writer';
import type { ValidationRunner } from '../src/validation/command-runner';
import type { BatchConfig, DependabotPR } from '../src/types';

const baseConfig: BatchConfig = {
  mode: 'batch',
  owner: 'acme',
  repo: 'app',
  baseBranch: 'main',
  integrationBranchPrefix: 'chore/dependabot-batch',
  dependabotAuthor: 'dependabot[bot]',
  validationCommand: 'npm test',
  onFailure: 'skip',
  reRunFinalSuite: false,
  draftPr: true,
  maxPrs: 20,
};

function makePr(overrides: Partial<DependabotPR> = {}): DependabotPR {
  return {
    number: 1,
    title: 'bump foo from 1.0 to 1.1',
    headRef: 'dependabot/npm/foo-1.1',
    headSha: 'abc123',
    htmlUrl: 'https://github.com/acme/app/pull/1',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('BatchOrchestrator', () => {
  it('records PASS when merge succeeds and validation passes', async () => {
    const pr = makePr();
    const prLister = { extractOpenPullRequests: vi.fn().mockResolvedValue([pr]) } satisfies Partial<DependabotPRLister> as DependabotPRLister;
    const branchManager = {
      createIntegrationBranch: vi.fn().mockResolvedValue('chore/dependabot-batch-2026-05-14'),
      push: vi.fn().mockResolvedValue(undefined),
      fetchPr: vi.fn().mockResolvedValue(undefined),
    } satisfies Partial<BranchManager> as BranchManager;
    const merger = {
      merge: vi.fn().mockResolvedValue({ kind: 'merged' }),
      dropLastMerge: vi.fn(),
    } satisfies Partial<PRMerger> as PRMerger;
    const validator: ValidationRunner = {
      run: vi.fn().mockResolvedValue({ passed: true, exitCode: 0, stdoutTail: '', stderrTail: '' }),
    };
    const analyzer: FailureAnalyzer = { explain: vi.fn() };
    const prWriter = {
      findExistingPr: vi.fn().mockResolvedValue(null),
      createPr: vi.fn().mockResolvedValue({ number: 99, url: 'https://example.test/pull/99' }),
      updatePrBody: vi.fn().mockResolvedValue(undefined),
      markPrAsReady: vi.fn().mockResolvedValue(undefined),
    } satisfies Partial<BatchPRWriter> as BatchPRWriter;

    const orchestrator = new BatchOrchestrator(
      prLister,
      branchManager,
      merger,
      validator,
      analyzer,
      new ReportBuilder(),
      prWriter,
    );

    const summary = await orchestrator.run(baseConfig);

    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]?.status).toBe('PASS');
    expect(merger.dropLastMerge).not.toHaveBeenCalled();
    expect(branchManager.push).toHaveBeenCalledWith('chore/dependabot-batch-2026-05-14');
    expect(analyzer.explain).not.toHaveBeenCalled();
  });

  it('records FAIL with merge-conflict and does not call validator', async () => {
    const pr = makePr({ number: 2 });
    const prLister = { extractOpenPullRequests: vi.fn().mockResolvedValue([pr]) } satisfies Partial<DependabotPRLister> as DependabotPRLister;
    const branchManager = {
      createIntegrationBranch: vi.fn().mockResolvedValue('chore/dependabot-batch-2026-05-14'),
      push: vi.fn(),
      fetchPr: vi.fn().mockResolvedValue(undefined),
    } satisfies Partial<BranchManager> as BranchManager;
    const merger = {
      merge: vi.fn().mockResolvedValue({ kind: 'conflict', conflictedFiles: ['package.json'] }),
      dropLastMerge: vi.fn(),
    } satisfies Partial<PRMerger> as PRMerger;
    const validator: ValidationRunner = { run: vi.fn() };
    const analyzer: FailureAnalyzer = { explain: vi.fn() };
    const prWriter = {
      findExistingPr: vi.fn().mockResolvedValue(null),
      createPr: vi.fn().mockResolvedValue({ number: 99, url: 'u' }),
      updatePrBody: vi.fn().mockResolvedValue(undefined),
      markPrAsReady: vi.fn(),
    } satisfies Partial<BatchPRWriter> as BatchPRWriter;

    const orchestrator = new BatchOrchestrator(
      prLister,
      branchManager,
      merger,
      validator,
      analyzer,
      new ReportBuilder(),
      prWriter,
    );

    const summary = await orchestrator.run(baseConfig);

    expect(summary.results[0]?.status).toBe('FAIL');
    expect(summary.results[0]?.failure?.kind).toBe('merge-conflict');
    expect(validator.run).not.toHaveBeenCalled();
    expect(analyzer.explain).not.toHaveBeenCalled();
  });

  it('drops the failed merge and asks the analyzer to explain on validation failure', async () => {
    const pr = makePr({ number: 3 });
    const prLister = { extractOpenPullRequests: vi.fn().mockResolvedValue([pr]) } satisfies Partial<DependabotPRLister> as DependabotPRLister;
    const branchManager = {
      createIntegrationBranch: vi.fn().mockResolvedValue('chore/dependabot-batch-2026-05-14'),
      push: vi.fn(),
      fetchPr: vi.fn().mockResolvedValue(undefined),
    } satisfies Partial<BranchManager> as BranchManager;
    const merger = {
      merge: vi.fn().mockResolvedValue({ kind: 'merged' }),
      dropLastMerge: vi.fn().mockResolvedValue(undefined),
    } satisfies Partial<PRMerger> as PRMerger;
    const validator: ValidationRunner = {
      run: vi
        .fn()
        .mockResolvedValue({ passed: false, exitCode: 1, stdoutTail: 'boom', stderrTail: 'oops' }),
    };
    const analyzer: FailureAnalyzer = {
      explain: vi.fn().mockResolvedValue({
        category: 'unknown',
        categoryLabel: 'unknown',
        cause: 'broke X',
        exitCode: 1,
        summary: 'broke X',
        body: 'long story',
      }),
    };
    const prWriter = {
      findExistingPr: vi.fn().mockResolvedValue(null),
      createPr: vi.fn().mockResolvedValue({ number: 99, url: 'u' }),
      updatePrBody: vi.fn().mockResolvedValue(undefined),
      markPrAsReady: vi.fn(),
    } satisfies Partial<BatchPRWriter> as BatchPRWriter;

    const orchestrator = new BatchOrchestrator(
      prLister,
      branchManager,
      merger,
      validator,
      analyzer,
      new ReportBuilder(),
      prWriter,
    );

    const summary = await orchestrator.run(baseConfig);

    expect(summary.results[0]?.status).toBe('FAIL');
    expect(merger.dropLastMerge).toHaveBeenCalledWith('skip', pr);
    expect(analyzer.explain).toHaveBeenCalledOnce();
  });
});

describe('ReportBuilder', () => {
  it('round-trips PASSed PR numbers via the machine-readable block', () => {
    const builder = new ReportBuilder();
    const body = builder.build({
      integrationBranch: 'b',
      baseBranch: 'main',
      results: [
        { pr: { ...makePr({ number: 11 }) }, status: 'PASS' },
        { pr: { ...makePr({ number: 12 }) }, status: 'FAIL', failure: { kind: 'merge-conflict', files: ['x'] } },
        { pr: { ...makePr({ number: 13 }) }, status: 'PASS' },
      ],
    });
    expect(ReportBuilder.parsePassedPrNumbers(body)).toEqual([11, 13]);
  });
});
