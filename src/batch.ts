import { StaticFailureAnalyzer, type FailureAnalyzer } from './analysis/analyzer';
import { ClaudeFailureAnalyzer } from './analysis/claude-analyzer';
import { BranchManager } from './git/branch-manager';
import { GitRunner } from './git/git-runner';
import { PRMerger } from './git/merger';
import { GitHubClient } from './github/client';
import { DependabotPRLister } from './github/pr-lister';
import { BatchPRWriter } from './github/pr-writer';
import { BatchOrchestrator } from './orchestrator';
import { ReportBuilder } from './report/builder';
import {
  ClaudeAgenticResolver,
  NoopAgenticResolver,
  type AgenticResolver,
} from './resolve/claude-resolver';
import type { BatchConfig, BatchSummary } from './types';
import { CommandValidationRunner } from './validation/command-runner';

const GIT_BOT_NAME = 'dependabot-batch-merge[bot]';
const GIT_BOT_EMAIL = 'dependabot-batch-merge@users.noreply.github.com';

export interface ExecuteBatchOptions {
  config: BatchConfig;
  token: string;
  anthropicApiKey?: string;
}

export async function executeBatch(options: ExecuteBatchOptions): Promise<BatchSummary> {
  const { config, token, anthropicApiKey } = options;

  // No key => subscription mode: the spawned CLI agent authenticates via the
  // claude.ai login. Only the SDK-based analyzer needs a real key (falls back to
  // static explanations without one).
  const gitRunner = new GitRunner();
  await gitRunner.configureIdentity(GIT_BOT_NAME, GIT_BOT_EMAIL);

  const gh = new GitHubClient(token, config.owner, config.repo);
  const branchManager = new BranchManager(gitRunner);
  const merger = new PRMerger(gitRunner);
  const validator = new CommandValidationRunner(config.validationCommand);
  const analyzer = buildAnalyzer(anthropicApiKey);
  const reporter = new ReportBuilder();
  const prLister = new DependabotPRLister(gh);
  const prWriter = new BatchPRWriter(gh);
  const resolver = buildResolver(anthropicApiKey, gitRunner, config);

  const orchestrator = new BatchOrchestrator(
    prLister,
    branchManager,
    merger,
    validator,
    analyzer,
    reporter,
    prWriter,
    resolver,
  );

  return orchestrator.run(config);
}

function buildAnalyzer(anthropicApiKey?: string): FailureAnalyzer {
  if (!anthropicApiKey) return new StaticFailureAnalyzer();
  return new ClaudeFailureAnalyzer({ apiKey: anthropicApiKey });
}

function buildResolver(
  anthropicApiKey: string | undefined,
  gitRunner: GitRunner,
  config: BatchConfig,
): AgenticResolver {
  if (!config.agenticResolve) return new NoopAgenticResolver();
  return new ClaudeAgenticResolver(anthropicApiKey, gitRunner, config.agentTimeoutSeconds * 1000);
}
