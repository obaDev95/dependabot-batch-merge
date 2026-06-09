import { StaticFailureAnalyzer, type FailureAnalyzer } from './analysis/analyzer';
import { CursorFailureAnalyzer } from './analysis/cursor-analyzer';
import { BranchManager } from './git/branch-manager';
import { GitRunner } from './git/git-runner';
import { PRMerger } from './git/merger';
import { GitHubClient } from './github/client';
import { DependabotPRLister } from './github/pr-lister';
import { BatchPRWriter } from './github/pr-writer';
import { BatchOrchestrator } from './orchestrator';
import { ReportBuilder } from './report/builder';
import type { BatchConfig, BatchSummary } from './types';
import { CommandValidationRunner } from './validation/command-runner';

const GIT_BOT_NAME = 'dependabot-batch-merge[bot]';
const GIT_BOT_EMAIL = 'dependabot-batch-merge@users.noreply.github.com';

export interface ExecuteBatchOptions {
  config: BatchConfig;
  token: string;
  cursorApiKey?: string;
}

export async function executeBatch(options: ExecuteBatchOptions): Promise<BatchSummary> {
  const { config, token, cursorApiKey } = options;

  const gitRunner = new GitRunner();
  await gitRunner.configureIdentity(GIT_BOT_NAME, GIT_BOT_EMAIL);

  const gh = new GitHubClient(token, config.owner, config.repo);
  const branchManager = new BranchManager(gitRunner);
  const merger = new PRMerger(gitRunner);
  const validator = new CommandValidationRunner(config.validationCommand);
  const analyzer = buildAnalyzer(cursorApiKey);
  const reporter = new ReportBuilder();
  const prLister = new DependabotPRLister(gh);
  const prWriter = new BatchPRWriter(gh);

  const orchestrator = new BatchOrchestrator(
    prLister,
    branchManager,
    merger,
    validator,
    analyzer,
    reporter,
    prWriter,
  );

  return orchestrator.run(config);
}

function buildAnalyzer(cursorApiKey?: string): FailureAnalyzer {
  if (!cursorApiKey) return new StaticFailureAnalyzer();
  return new CursorFailureAnalyzer({ apiKey: cursorApiKey });
}
