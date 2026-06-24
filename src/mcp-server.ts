#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { executeBatch } from './batch';
import type { FailureHandling } from './types';

const server = new McpServer({
  name: 'dependabot-batch-merge',
  version: '0.1.0',
});

server.registerTool(
  'run-batch-merge',
  {
    title: 'Run batch merge',
    description:
      'Batch open Dependabot PRs into one integration branch, validate each merge, and open a single PR to the base branch. ' +
      'Defaults: token from $GITHUB_TOKEN/$GH_TOKEN, anthropicApiKey from $ANTHROPIC_API_KEY, repo from $BATCH_MERGE_REPO. ' +
      'Run from inside a checkout of the target repo — the tool operates on the current working directory.',
    inputSchema: {
      token: z.string().optional().describe('GitHub token with repo scope. Defaults to $GITHUB_TOKEN or $GH_TOKEN.'),
      owner: z.string().default('Maersk-Global').describe('GitHub repository owner'),
      repo: z.string().optional().describe('GitHub repository name. Defaults to $BATCH_MERGE_REPO.'),
      baseBranch: z.string().default('main').describe('Base branch for the batch PR'),
      integrationBranchPrefix: z
        .string()
        .default('chore/dependabot-batch')
        .describe('Prefix for the integration branch'),
      validationCommand: z
        .string()
        .default('npm ci && npm run typecheck && npm test && npm run build')
        .describe('Shell command to validate each merge'),
      onFailure: z
        .enum(['skip', 'revert-commit'])
        .default('skip')
        .describe('How to handle a PR that fails validation'),
      reRunFinalSuite: z
        .boolean()
        .default(true)
        .describe('Re-run validation on the final integration branch tip'),
      draftPr: z.boolean().default(true).describe('Open the batch PR as a draft'),
      maxPrs: z
        .number()
        .int()
        .positive()
        .default(20)
        .describe('Maximum Dependabot PRs to process'),
      anthropicApiKey: z
        .string()
        .optional()
        .describe('Anthropic API key for Claude-powered failure explanations and agentic resolution. Defaults to $ANTHROPIC_API_KEY.'),
      agenticResolve: z.boolean().default(false).describe('Invoke Claude agent to attempt fixes before recording failures'),
      agentTimeoutSeconds: z.number().int().positive().default(600).describe('Per-attempt timeout for the Claude agent'),
    },
  },
  async ({
    token,
    anthropicApiKey,
    owner,
    repo,
    baseBranch,
    integrationBranchPrefix,
    validationCommand,
    onFailure,
    reRunFinalSuite,
    draftPr,
    maxPrs,
    agenticResolve,
    agentTimeoutSeconds,
  }) => {
    const resolvedToken = token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!resolvedToken) {
      throw new Error('Set GITHUB_TOKEN (or GH_TOKEN) in your environment, or pass token explicitly.');
    }
    const resolvedRepo = repo ?? process.env.BATCH_MERGE_REPO;
    if (!resolvedRepo) {
      throw new Error('Set BATCH_MERGE_REPO in your environment, or pass repo explicitly.');
    }
    const resolvedApiKey = anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;

    const summary = await executeBatch({
      config: {
        owner,
        repo: resolvedRepo,
        baseBranch,
        integrationBranchPrefix,
        validationCommand,
        onFailure: onFailure as FailureHandling,
        reRunFinalSuite,
        draftPr,
        maxPrs,
        dependabotAuthor: 'dependabot[bot]',
        agenticResolve,
        agentTimeoutSeconds,
      },
      token: resolvedToken,
      anthropicApiKey: resolvedApiKey,
    });

    const passCount = summary.results.filter((r) => r.status === 'PASS').length;
    const failCount = summary.results.filter((r) => r.status === 'FAIL').length;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              batchPrNumber: summary.batchPrNumber ?? null,
              batchPrUrl: summary.batchPrUrl ?? null,
              passCount,
              failCount,
              results: summary.results.map((r) => ({
                pr: r.pr.number,
                title: r.pr.title,
                status: r.status,
                failure: r.failure?.kind ?? null,
                agent: r.agentAttempt
                  ? {
                      kind: 'resolved' as const,
                      commitSha: r.agentAttempt.commitSha,
                      summary: r.agentAttempt.summary,
                    }
                  : r.agentGaveUp
                    ? {
                        kind: 'gave-up' as const,
                        stage: r.agentGaveUp.stage,
                        reason: r.agentGaveUp.reason,
                      }
                    : { kind: 'none' as const },
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[dependabot-batch-merge] MCP server connected and listening');
}

main().catch((err) => {
  console.error('[dependabot-batch-merge] Fatal error:', err);
  process.exit(1);
});
