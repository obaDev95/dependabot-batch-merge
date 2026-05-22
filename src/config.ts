import * as core from '@actions/core';
import type { BatchConfig, FailureHandling } from './types';

export class ConfigError extends Error {}

// v1 is hard-locked to a single target repository. The validation command is
// the canonical pre-flight suite for ui-myfinance. Onboarding other repos
// (or changing the suite) requires a deliberate code change here.
const TARGET_OWNER = 'Maersk-Global';
const TARGET_REPO = 'ui-myfinance';
const VALIDATION_COMMAND = 'npm ci && npm run typecheck && npm test && npm run build';

export function parseConfig(): BatchConfig {
  const baseBranch = core.getInput('base-branch') || 'main';
  const integrationBranchPrefix =
    core.getInput('integration-branch-prefix') || 'chore/dependabot-batch';

  return {
    owner: TARGET_OWNER,
    repo: TARGET_REPO,
    baseBranch,
    integrationBranchPrefix,
    dependabotAuthor: core.getInput('dependabot-author') || 'dependabot[bot]',
    validationCommand: VALIDATION_COMMAND,
    onFailure: parseFailureHandling(core.getInput('on-failure') || 'skip'),
    reRunFinalSuite: parseBool(core.getInput('re-run-final-suite'), true),
    draftPr: parseBool(core.getInput('draft-pr'), true),
    maxPrs: parsePositiveInt(core.getInput('max-prs') || '20', 'max-prs'),
    closeSourcePrs: parseBool(core.getInput('close-source-prs'), false),
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
