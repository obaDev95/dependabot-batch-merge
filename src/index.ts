import * as core from '@actions/core';
import { executeBatch } from './batch';
import { parseConfig } from './config';

async function main(): Promise<void> {
  const config = parseConfig();
  const token = core.getInput('github-token', { required: true });
  const cursorApiKey = core.getInput('cursor-api-key') || undefined;

  const summary = await executeBatch({ config, token, cursorApiKey });

  core.setOutput('batch-pr-number', summary.batchPrNumber ?? '');
  core.setOutput('batch-pr-url', summary.batchPrUrl ?? '');
  core.setOutput('pass-count', summary.results.filter((r) => r.status === 'PASS').length);
  core.setOutput('fail-count', summary.results.filter((r) => r.status === 'FAIL').length);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  core.setFailed(message);
});
