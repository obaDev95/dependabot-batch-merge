import * as core from '@actions/core';
import type { BatchConfig, FailureHandling } from './types';

export class ConfigError extends Error {}

export function parseConfig(): BatchConfig {
  return {
    owner: 'Maersk-Global',
    repo: 'ui-myfinance',
    baseBranch: 'main',
    integrationBranchPrefix: 'chore/dependabot-batch',
    dependabotAuthor: 'dependabot[bot]',
    validationCommand: 'npm ci && npm run typecheck && npm test && npm run build',
    onFailure: parseFailureHandling(core.getInput('on-failure') || 'skip'),
    reRunFinalSuite: parseBool(core.getInput('re-run-final-suite'), true),
    draftPr: parseBool(core.getInput('draft-pr'), true),
    maxPrs: parsePositiveInt(core.getInput('max-prs') || '20', 'max-prs'),
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
