import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { executeBatch } from './batch';
import type { FailureHandling } from './types';

const server = new Server(
  {
    name: 'dependabot-batch-merge',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const runBatchMergeTool: Tool = {
  name: 'run-batch-merge',
  description:
    'Batch open Dependabot PRs into one integration branch, validate each merge, and open a single PR to the base branch.',
  inputSchema: {
    type: 'object',
    properties: {
      token: { type: 'string', description: 'GitHub token with repo scope' },
      owner: { type: 'string', description: 'GitHub repository owner', default: 'Maersk-Global' },
      repo: { type: 'string', description: 'GitHub repository name', default: 'ui-myfinance' },
      baseBranch: { type: 'string', description: 'Base branch for the batch PR', default: 'main' },
      integrationBranchPrefix: {
        type: 'string',
        description: 'Prefix for the integration branch',
        default: 'chore/dependabot-batch',
      },
      validationCommand: {
        type: 'string',
        description: 'Shell command to validate each merge',
        default: 'npm ci && npm run typecheck && npm test && npm run build',
      },
      onFailure: {
        type: 'string',
        enum: ['skip', 'revert-commit'],
        description: 'How to handle a PR that fails validation',
        default: 'skip',
      },
      reRunFinalSuite: {
        type: 'boolean',
        description: 'Re-run validation on the final integration branch tip',
        default: true,
      },
      draftPr: { type: 'boolean', description: 'Open the batch PR as a draft', default: true },
      maxPrs: {
        type: 'number',
        description: 'Maximum Dependabot PRs to process',
        default: 20,
      },
      cursorApiKey: {
        type: 'string',
        description: 'Cursor Cloud API key for failure explanations',
      },
    },
    required: ['token'],
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [runBatchMergeTool],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'run-batch-merge') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  const params = request.params.arguments as Record<string, unknown>;

  const schema = z.object({
    token: z.string(),
    owner: z.string().default('Maersk-Global'),
    repo: z.string().default('ui-myfinance'),
    baseBranch: z.string().default('main'),
    integrationBranchPrefix: z.string().default('chore/dependabot-batch'),
    validationCommand: z
      .string()
      .default('npm ci && npm run typecheck && npm test && npm run build'),
    onFailure: z.enum(['skip', 'revert-commit']).default('skip'),
    reRunFinalSuite: z.boolean().default(true),
    draftPr: z.boolean().default(true),
    maxPrs: z.number().int().positive().default(20),
    cursorApiKey: z.string().optional(),
  });

  const parsed = schema.parse(params);
  const { token, cursorApiKey, ...configFields } = parsed;

  const summary = await executeBatch({
    config: {
      ...configFields,
      onFailure: configFields.onFailure as FailureHandling,
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
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
