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
      'Batch open Dependabot PRs into one integration branch, validate each merge, and open a single PR to the base branch.',
    inputSchema: {
      token: z.string().describe('GitHub token with repo scope'),
      owner: z.string().default('Maersk-Global').describe('GitHub repository owner'),
      repo: z.string().default('ui-myfinance').describe('GitHub repository name'),
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
      cursorApiKey: z
        .string()
        .optional()
        .describe('Cursor Cloud API key for failure explanations'),
    },
  },
  async ({
    token,
    cursorApiKey,
    owner,
    repo,
    baseBranch,
    integrationBranchPrefix,
    validationCommand,
    onFailure,
    reRunFinalSuite,
    draftPr,
    maxPrs,
  }) => {
    const summary = await executeBatch({
      config: {
        owner,
        repo,
        baseBranch,
        integrationBranchPrefix,
        validationCommand,
        onFailure: onFailure as FailureHandling,
        reRunFinalSuite,
        draftPr,
        maxPrs,
        dependabotAuthor: 'dependabot[bot]',
      },
      token,
      cursorApiKey,
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
