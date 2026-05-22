import * as core from '@actions/core';
import type { BatchConfig, FailureHandling } from './types';

export class ConfigError extends Error {}

const V1_ALLOWED_TARGET_REPO = 'Maersk-Global/ui-myfinance';

export function parseConfig(): BatchConfig {
  const { owner, repo } = resolveTargetRepo();
  const baseBranch = core.getInput('base-branch') || 'main';
  const integrationBranchPrefix =
    core.getInput('integration-branch-prefix') || 'chore/dependabot-batch';

  const validationCommand = core.getInput('validation-command');
  if (!validationCommand) {
    throw new ConfigError('validation-command is required');
  }

  return {
    owner,
    repo,
    baseBranch,
    integrationBranchPrefix,
    dependabotAuthor: core.getInput('dependabot-author') || 'dependabot[bot]',
    validationCommand,
    onFailure: parseFailureHandling(core.getInput('on-failure') || 'skip'),
    reRunFinalSuite: parseBool(core.getInput('re-run-final-suite'), true),
    draftPr: parseBool(core.getInput('draft-pr'), true),
    maxPrs: parsePositiveInt(core.getInput('max-prs') || '20', 'max-prs'),
    closeSourcePrs: parseBool(core.getInput('close-source-prs'), false),
  };
}

// v1 is hard-locked to a single target repository. Onboarding other teams is
// a deliberate follow-up — it requires a code change here (and a fresh release)
// so any expansion of scope is reviewed, not implicit.
function resolveTargetRepo(): { owner: string; repo: string } {
  const targetRepo = core.getInput('target-repo').trim();
  if (targetRepo !== V1_ALLOWED_TARGET_REPO) {
    throw new ConfigError(
      `target-repo must be "${V1_ALLOWED_TARGET_REPO}" in v1 (got "${targetRepo}"). ` +
        `Onboarding additional repositories is a separate change.`,
    );
  }
  const [owner, repo] = V1_ALLOWED_TARGET_REPO.split('/') as [string, string];
  return { owner, repo };
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
