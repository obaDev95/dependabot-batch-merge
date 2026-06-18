import * as core from '@actions/core';
import type { BatchConfig, FailureHandling } from './types';

export class ConfigError extends Error {}

const DEFAULT_VALIDATION_COMMAND = 'npm ci && npm run typecheck && npm test && npm run build';

export function parseConfig(): BatchConfig {
  return {
    owner: 'Maersk-Global',
    repo: 'ui-myfinance',
    baseBranch: core.getInput('base-branch') || 'main',
    integrationBranchPrefix:
      core.getInput('integration-branch-prefix') || 'chore/dependabot-batch',
    dependabotAuthor: core.getInput('dependabot-author') || 'dependabot[bot]',
    validationCommand: core.getInput('validation-command') || DEFAULT_VALIDATION_COMMAND,
    onFailure: parseFailureHandling(core.getInput('on-failure') || 'skip'),
    reRunFinalSuite: parseBool(core.getInput('re-run-final-suite'), true),
    draftPr: parseBool(core.getInput('draft-pr'), true),
    maxPrs: parsePositiveInt(core.getInput('max-prs') || '20', 'max-prs'),
    agenticResolve: parseBool(core.getInput('agentic-resolve'), false),
    agentTimeoutSeconds: parsePositiveInt(core.getInput('agent-timeout-seconds') || '600', 'agent-timeout-seconds'),
  };
}

function parseFailureHandling(raw: string): FailureHandling {
  if (raw === 'skip' || raw === 'revert-commit') return raw;
  throw new ConfigError(`on-failure must be "skip" or "revert-commit", got "${raw}"`);
}

function parseBool(raw: string, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  throw new ConfigError(`expected boolean, got "${raw}"`);
}

function parsePositiveInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}
