import * as core from '@actions/core';
import { StaticFailureAnalyzer, type FailureAnalyzer } from './analysis/analyzer';
import { CursorFailureAnalyzer } from './analysis/cursor-analyzer';
import { parseConfig } from './config';
import { BranchManager } from './git/branch-manager';
import { GitRunner } from './git/git-runner';
import { PRMerger } from './git/merger';
import { GitHubClient } from './github/client';
import { DependabotPRLister } from './github/pr-lister';
import { BatchPRWriter } from './github/pr-writer';
import { SourcePRCloser } from './github/source-pr-closer';
import { BatchOrchestrator } from './orchestrator';
import { ReportBuilder } from './report/builder';
import type { BatchConfig, BatchSummary } from './types';
import { CommandValidationRunner } from './validation/command-runner';

const GIT_BOT_NAME = 'dependabot-batch-merge[bot]';
const GIT_BOT_EMAIL = 'dependabot-batch-merge@users.noreply.github.com';

async function main(): Promise<void> {
  const config = parseConfig();
  const token = core.getInput('github-token', { required: true });
  const gh = new GitHubClient(token, config.owner, config.repo);

  const summary = await runBatch(config, gh);
  core.setOutput('batch-pr-number', summary.batchPrNumber ?? '');
  core.setOutput('batch-pr-url', summary.batchPrUrl ?? '');
  core.setOutput('pass-count', summary.results.filter((r) => r.status === 'PASS').length);
  core.setOutput('fail-count', summary.results.filter((r) => r.status === 'FAIL').length);
}

async function runBatch(config: BatchConfig, gh: GitHubClient): Promise<BatchSummary> {
  const gitRunner = new GitRunner();
  await gitRunner.configureIdentity(GIT_BOT_NAME, GIT_BOT_EMAIL);

  const branchManager = new BranchManager(gitRunner);
  const merger = new PRMerger(gitRunner);
  const validator = new CommandValidationRunner(config.validationCommand);
  const analyzer = buildAnalyzer();
  const reporter = new ReportBuilder();
  const prLister = new DependabotPRLister(gh);
  const prWriter = new BatchPRWriter(gh);
  const sourcePrCloser = new SourcePRCloser(gh);

  const orchestrator = new BatchOrchestrator(
    prLister,
    branchManager,
    merger,
    validator,
    analyzer,
    reporter,
    prWriter,
    sourcePrCloser,
  );

  return orchestrator.run(config);
}

function buildAnalyzer(): FailureAnalyzer {
  const apiKey = core.getInput('cursor-api-key');
  if (!apiKey) {
    core.info('cursor-api-key not provided — falling back to static failure explanations');
    return new StaticFailureAnalyzer();
  }
  return new CursorFailureAnalyzer({ apiKey });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  core.setFailed(message);
});
