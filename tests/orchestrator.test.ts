import { describe, expect, it, vi } from 'vitest';
import { BatchOrchestrator } from '../src/orchestrator';
import { ReportBuilder } from '../src/report/builder';
import type { FailureAnalyzer } from '../src/analysis/analyzer';
import type { BranchManager } from '../src/git/branch-manager';
import type { PRMerger } from '../src/git/merger';
import type { DependabotPRLister } from '../src/github/pr-lister';
import type { BatchPRWriter } from '../src/github/pr-writer';
import type { AgenticResolver } from '../src/resolve/claude-resolver';
import type { ValidationRunner } from '../src/validation/command-runner';
import type { BatchConfig, DependabotPR } from '../src/types';

const baseConfig: BatchConfig = {
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
  agenticResolve: false,
  agentTimeoutSeconds: 600,
  maxAgentCallsPerBatch: 10,
  maxBatchWallClockSeconds: 3600,
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

const passValidation = { passed: true, exitCode: 0, stdoutTail: '', stderrTail: '' };
const failValidation = { passed: false, exitCode: 1, stdoutTail: 'boom', stderrTail: 'oops' };

function makeMerger(overrides: Partial<Record<keyof PRMerger, unknown>> = {}): PRMerger {
  return {
    merge: vi.fn().mockResolvedValue({ kind: 'merged' }),
    dropLastMerge: vi.fn().mockResolvedValue(undefined),
    abortMerge: vi.fn().mockResolvedValue(undefined),
    headSha: vi.fn().mockResolvedValue('pre-sha'),
    resetTo: vi.fn().mockResolvedValue(undefined),
    revertRange: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PRMerger;
}

function makeNoop(): AgenticResolver {
  return {
    resolveConflict: vi.fn().mockResolvedValue({ kind: 'gave-up', reason: 'disabled', outputTail: '' }),
    resolveValidation: vi.fn().mockResolvedValue({ kind: 'gave-up', reason: 'disabled', outputTail: '' }),
  };
}

function makeOrchestrator(
  prLister: DependabotPRLister,
  branchManager: BranchManager,
  merger: PRMerger,
  validator: ValidationRunner,
  analyzer: FailureAnalyzer,
  resolver: AgenticResolver = makeNoop(),
): BatchOrchestrator {
  const prWriter = {
    findExistingPr: vi.fn().mockResolvedValue(null),
    createPr: vi.fn().mockResolvedValue({ number: 99, url: 'https://example.test/pull/99' }),
    updatePrBody: vi.fn().mockResolvedValue(undefined),
    markPrAsReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as BatchPRWriter;
  return new BatchOrchestrator(prLister, branchManager, merger, validator, analyzer, new ReportBuilder(), prWriter, resolver);
}

function makeBranchManager(pushResult: object = { kind: 'pushed' }): BranchManager {
  return {
    createIntegrationBranch: vi.fn().mockResolvedValue('chore/dependabot-batch-2026-05-14'),
    push: vi.fn().mockResolvedValue(pushResult),
    fetchPr: vi.fn().mockResolvedValue(undefined),
  } as unknown as BranchManager;
}

function makeLister(prs: DependabotPR[]): DependabotPRLister {
  return { extractOpenPullRequests: vi.fn().mockResolvedValue(prs) } as unknown as DependabotPRLister;
}

describe('BatchOrchestrator — baseline paths', () => {
  it('records PASS when merge succeeds and validation passes', async () => {
    const pr = makePr();
    const merger = makeMerger();
    const validator: ValidationRunner = { run: vi.fn().mockResolvedValue(passValidation) };
    const analyzer: FailureAnalyzer = { explain: vi.fn() };

    const orchestrator = makeOrchestrator(makeLister([pr]), makeBranchManager(), merger, validator, analyzer);
    const summary = await orchestrator.run(baseConfig);

    expect(summary.results[0]?.status).toBe('PASS');
    expect(merger.dropLastMerge).not.toHaveBeenCalled();
    expect(analyzer.explain).not.toHaveBeenCalled();
  });

  it('records FAIL with merge-conflict and aborts merge (non-agentic)', async () => {
    const pr = makePr({ number: 2 });
    const merger = makeMerger({
      merge: vi.fn().mockResolvedValue({ kind: 'conflict', conflictedFiles: ['package.json'] }),
    });
    const validator: ValidationRunner = { run: vi.fn() };
    const analyzer: FailureAnalyzer = { explain: vi.fn() };

    const orchestrator = makeOrchestrator(makeLister([pr]), makeBranchManager(), merger, validator, analyzer);
    const summary = await orchestrator.run(baseConfig);

    expect(summary.results[0]?.status).toBe('FAIL');
    expect(summary.results[0]?.failure?.kind).toBe('merge-conflict');
    expect(merger.abortMerge).toHaveBeenCalledOnce();
    expect(validator.run).not.toHaveBeenCalled();
    expect(analyzer.explain).not.toHaveBeenCalled();
  });

  it('drops the failed merge and asks the analyzer to explain on validation failure', async () => {
    const pr = makePr({ number: 3 });
    const merger = makeMerger();
    const validator: ValidationRunner = { run: vi.fn().mockResolvedValue(failValidation) };
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

    const orchestrator = makeOrchestrator(makeLister([pr]), makeBranchManager(), merger, validator, analyzer);
    const summary = await orchestrator.run(baseConfig);

    expect(summary.results[0]?.status).toBe('FAIL');
    expect(merger.dropLastMerge).toHaveBeenCalledWith('skip', pr);
    expect(analyzer.explain).toHaveBeenCalledOnce();
  });
});

describe('BatchOrchestrator — agentic paths', () => {
  const agenticConfig: BatchConfig = { ...baseConfig, agenticResolve: true };

  it('records PASS with agentAttempt when conflict resolved by agent + revalidation passes', async () => {
    const pr = makePr({ number: 10 });
    const merger = makeMerger({
      merge: vi.fn().mockResolvedValue({ kind: 'conflict', conflictedFiles: ['package.json'] }),
    });
    const validator: ValidationRunner = { run: vi.fn().mockResolvedValue(passValidation) };
    const analyzer: FailureAnalyzer = { explain: vi.fn() };
    const resolver: AgenticResolver = {
      resolveConflict: vi.fn().mockResolvedValue({
        kind: 'resolved',
        commitSha: 'fix-sha',
        summary: 'resolved lockfile conflict',
        outputTail: 'agent output',
      }),
      resolveValidation: vi.fn(),
    };

    const orchestrator = makeOrchestrator(makeLister([pr]), makeBranchManager(), merger, validator, analyzer, resolver);
    const summary = await orchestrator.run(agenticConfig);

    expect(summary.results[0]?.status).toBe('PASS');
    expect(summary.results[0]?.agentAttempt?.commitSha).toBe('fix-sha');
    expect(merger.abortMerge).not.toHaveBeenCalled();
    expect(analyzer.explain).not.toHaveBeenCalled();
  });

  it('falls back to merge-conflict FAIL when resolver gives up on conflict', async () => {
    const pr = makePr({ number: 11 });
    const merger = makeMerger({
      merge: vi.fn().mockResolvedValue({ kind: 'conflict', conflictedFiles: ['a.ts'] }),
    });
    const validator: ValidationRunner = { run: vi.fn() };
    const resolver: AgenticResolver = {
      resolveConflict: vi.fn().mockResolvedValue({ kind: 'gave-up', reason: 'too complex', outputTail: '' }),
      resolveValidation: vi.fn(),
    };

    const orchestrator = makeOrchestrator(makeLister([pr]), makeBranchManager(), merger, validator, resolver as unknown as FailureAnalyzer, resolver);
    // Note: analyzer is not called for plain merge-conflict, so passing resolver as analyzer is fine here
    const summary = await orchestrator.run(agenticConfig);

    expect(summary.results[0]?.status).toBe('FAIL');
    expect(summary.results[0]?.failure?.kind).toBe('merge-conflict');
    expect(merger.abortMerge).toHaveBeenCalledOnce();
    expect(summary.results[0]?.agentAttempt).toBeUndefined();
    expect(validator.run).not.toHaveBeenCalled();
  });

  it('populates agentGaveUp on PRResult when resolver gives up on conflict', async () => {
    const pr = makePr({ number: 15 });
    const merger = makeMerger({
      merge: vi.fn().mockResolvedValue({ kind: 'conflict', conflictedFiles: ['package-lock.json'] }),
    });
    const validator: ValidationRunner = { run: vi.fn() };
    const resolver: AgenticResolver = {
      resolveConflict: vi.fn().mockResolvedValue({
        kind: 'gave-up',
        reason: 'agent made no commits',
        outputTail: 'tool: Bash\nerror: merge conflict beyond auto-resolution',
      }),
      resolveValidation: vi.fn(),
    };
    const analyzer: FailureAnalyzer = { explain: vi.fn() };

    const orchestrator = makeOrchestrator(makeLister([pr]), makeBranchManager(), merger, validator, analyzer, resolver);
    const summary = await orchestrator.run(agenticConfig);

    expect(summary.results[0]?.status).toBe('FAIL');
    expect(summary.results[0]?.failure?.kind).toBe('merge-conflict');
    expect(summary.results[0]?.agentAttempt).toBeUndefined();
    expect(summary.results[0]?.agentGaveUp).toEqual({
      stage: 'conflict',
      reason: 'agent made no commits',
      outputTail: 'tool: Bash\nerror: merge conflict beyond auto-resolution',
    });
    expect(merger.abortMerge).toHaveBeenCalledOnce();
  });

  it('populates agentGaveUp on PRResult when resolver gives up on validation', async () => {
    const pr = makePr({ number: 16 });
    const merger = makeMerger();
    const validator: ValidationRunner = { run: vi.fn().mockResolvedValue(failValidation) };
    const resolver: AgenticResolver = {
      resolveConflict: vi.fn(),
      resolveValidation: vi.fn().mockResolvedValue({
        kind: 'gave-up',
        reason: 'timed out after 600000ms',
        outputTail: 'agent partial output before timeout',
      }),
    };
    const analyzer: FailureAnalyzer = {
      explain: vi.fn().mockResolvedValue({
        category: 'type-error' as const,
        categoryLabel: 'TypeScript error',
        cause: 'tsc fail',
        exitCode: 1,
        summary: 'tsc fail',
        body: 'details',
      }),
    };

    const orchestrator = makeOrchestrator(makeLister([pr]), makeBranchManager(), merger, validator, analyzer, resolver);
    const summary = await orchestrator.run(agenticConfig);

    expect(summary.results[0]?.status).toBe('FAIL');
    expect(summary.results[0]?.failure?.kind).toBe('validation-failed');
    expect(summary.results[0]?.agentAttempt).toBeUndefined();
    expect(summary.results[0]?.agentGaveUp).toEqual({
      stage: 'validation',
      reason: 'timed out after 600000ms',
      outputTail: 'agent partial output before timeout',
    });
    expect(merger.dropLastMerge).toHaveBeenCalledWith('skip', pr);
    expect(analyzer.explain).toHaveBeenCalledOnce();
  });

  it('records PASS with agentAttempt when validation fix by agent + revalidation passes', async () => {
    const pr = makePr({ number: 12 });
    const merger = makeMerger();
    const validator: ValidationRunner = {
      run: vi.fn()
        .mockResolvedValueOnce(failValidation)  // first validation fails
        .mockResolvedValueOnce(passValidation),  // revalidation after agent fix passes
    };
    const analyzer: FailureAnalyzer = { explain: vi.fn() };
    const resolver: AgenticResolver = {
      resolveConflict: vi.fn(),
      resolveValidation: vi.fn().mockResolvedValue({
        kind: 'resolved',
        commitSha: 'agent-fix-sha',
        summary: 'fixed type error',
        outputTail: 'tsc output',
      }),
    };

    const orchestrator = makeOrchestrator(makeLister([pr]), makeBranchManager(), merger, validator, analyzer, resolver);
    const summary = await orchestrator.run(agenticConfig);

    expect(summary.results[0]?.status).toBe('PASS');
    expect(summary.results[0]?.agentAttempt?.commitSha).toBe('agent-fix-sha');
    expect(merger.dropLastMerge).not.toHaveBeenCalled();
    expect(merger.resetTo).not.toHaveBeenCalled();
    expect(analyzer.explain).not.toHaveBeenCalled();
  });

  it('records FAIL with agentAttempt when agent commits but revalidation still fails', async () => {
    const pr = makePr({ number: 13 });
    const merger = makeMerger();
    const validator: ValidationRunner = {
      run: vi.fn()
        .mockResolvedValueOnce(failValidation)  // first validation fails
        .mockResolvedValueOnce(failValidation), // revalidation after agent fix also fails
    };
    const explanation = {
      category: 'type-error' as const,
      categoryLabel: 'TypeScript error',
      cause: 'still broken',
      exitCode: 1,
      summary: 'still broken',
      body: 'details',
    };
    const analyzer: FailureAnalyzer = { explain: vi.fn().mockResolvedValue(explanation) };
    const resolver: AgenticResolver = {
      resolveConflict: vi.fn(),
      resolveValidation: vi.fn().mockResolvedValue({
        kind: 'resolved',
        commitSha: 'partial-fix',
        summary: 'partial fix',
        outputTail: '',
      }),
    };

    const orchestrator = makeOrchestrator(makeLister([pr]), makeBranchManager(), merger, validator, analyzer, resolver);
    const summary = await orchestrator.run(agenticConfig);

    expect(summary.results[0]?.status).toBe('FAIL');
    expect(summary.results[0]?.failure?.kind).toBe('validation-failed');
    expect(summary.results[0]?.agentAttempt?.commitSha).toBe('partial-fix');
    expect(merger.resetTo).toHaveBeenCalledWith('pre-sha');
    expect(merger.dropLastMerge).not.toHaveBeenCalled();
    expect(analyzer.explain).toHaveBeenCalledOnce();
  });

  it('reverts (not resets) and pushes when onFailure is revert-commit and agent fix still fails', async () => {
    const pr = makePr({ number: 14 });
    const merger = makeMerger();
    const validator: ValidationRunner = {
      run: vi.fn()
        .mockResolvedValueOnce(failValidation)
        .mockResolvedValueOnce(failValidation),
    };
    const analyzer: FailureAnalyzer = {
      explain: vi.fn().mockResolvedValue({
        category: 'type-error' as const,
        categoryLabel: 'TypeScript error',
        cause: 'still broken',
        exitCode: 1,
        summary: 'still broken',
        body: 'details',
      }),
    };
    const resolver: AgenticResolver = {
      resolveConflict: vi.fn(),
      resolveValidation: vi.fn().mockResolvedValue({
        kind: 'resolved',
        commitSha: 'partial-fix',
        summary: 'partial fix',
        outputTail: '',
      }),
    };
    const branchManager = makeBranchManager();

    const orchestrator = makeOrchestrator(makeLister([pr]), branchManager, merger, validator, analyzer, resolver);
    const revertConfig: BatchConfig = { ...baseConfig, agenticResolve: true, onFailure: 'revert-commit' };
    const summary = await orchestrator.run(revertConfig);

    expect(summary.results[0]?.status).toBe('FAIL');
    expect(merger.revertRange).toHaveBeenCalledWith('pre-sha', pr);
    expect(merger.resetTo).not.toHaveBeenCalled();
    expect(merger.dropLastMerge).not.toHaveBeenCalled();
    expect(branchManager.push).toHaveBeenCalledWith('chore/dependabot-batch-2026-05-14');
    expect(summary.results[0]?.failure?.kind).toBe('validation-failed');
  });
});

describe('BatchOrchestrator — guardrails', () => {
  it('stops invoking the resolver once maxAgentCallsPerBatch is reached', async () => {
    const prs = [makePr({ number: 20 }), makePr({ number: 21 }), makePr({ number: 22 })];
    const merger = makeMerger();
    const validator: ValidationRunner = { run: vi.fn().mockResolvedValue(failValidation) };
    const analyzer: FailureAnalyzer = {
      explain: vi.fn().mockResolvedValue({
        category: 'unknown' as const,
        categoryLabel: 'unknown',
        cause: 'broke',
        exitCode: 1,
        summary: 'broke',
        body: 'details',
      }),
    };
    const resolveValidation = vi.fn().mockResolvedValue({
      kind: 'gave-up',
      reason: 'agent made no commits',
      outputTail: 'tail',
    });
    const resolver: AgenticResolver = { resolveConflict: vi.fn(), resolveValidation };

    const orchestrator = makeOrchestrator(makeLister(prs), makeBranchManager(), merger, validator, analyzer, resolver);
    const cappedConfig: BatchConfig = { ...baseConfig, agenticResolve: true, maxAgentCallsPerBatch: 2 };
    const summary = await orchestrator.run(cappedConfig);

    expect(resolveValidation).toHaveBeenCalledTimes(2);
    expect(summary.results[2]?.agentGaveUp).toEqual({
      stage: 'guardrail',
      reason: 'agent-call-cap',
      outputTail: '',
    });
    expect(summary.results[0]?.agentGaveUp?.stage).toBe('validation');
    expect(summary.results[1]?.agentGaveUp?.stage).toBe('validation');
  });

  it('breaks the loop and marks remaining PRs as skipped when wall-clock cap is reached', async () => {
    const prs = [makePr({ number: 30 }), makePr({ number: 31 }), makePr({ number: 32 })];
    const merger = makeMerger();
    const validator: ValidationRunner = { run: vi.fn().mockResolvedValue(passValidation) };
    const analyzer: FailureAnalyzer = { explain: vi.fn() };

    // Stacked Date.now() returns: startedAt=0, iter-0 check=500ms (< 1s cap, process),
    // every subsequent call=5_000_000ms (>> 1s cap, break + skip remaining).
    const dateSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(500)
      .mockReturnValue(5_000_000);

    try {
      const orchestrator = makeOrchestrator(makeLister(prs), makeBranchManager(), merger, validator, analyzer);
      const tightConfig: BatchConfig = { ...baseConfig, maxBatchWallClockSeconds: 1 };
      const summary = await orchestrator.run(tightConfig);

      const passed = summary.results.filter((r) => r.status === 'PASS');
      const skipped = summary.results.filter((r) => r.skipped);
      expect(passed).toHaveLength(1);
      expect(skipped).toHaveLength(2);
      expect(skipped[0]?.skipped).toEqual({ reason: 'wall-clock-cap' });
      expect(skipped[0]?.status).toBe('FAIL');
      expect(skipped[1]?.pr.number).toBe(32);
    } finally {
      dateSpy.mockRestore();
    }
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
