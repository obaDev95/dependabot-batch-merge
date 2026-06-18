import type { FailureCategory } from '../analysis/categorize';
import type { AgentAttempt, PRResult, ValidationOutcome } from '../types';

const PASSED_PRS_BLOCK_START = '<!-- dependabot-batch-merge:passed-prs:start -->';
const PASSED_PRS_BLOCK_END = '<!-- dependabot-batch-merge:passed-prs:end -->';

type ReportCategoryKey =
  | FailureCategory
  | 'merge-conflict'
  | 'push-workflow-scope'
  | 'push-branch-protection'
  | 'push-other';

// Documentation rendered alongside each failure category so reviewers don't
// have to reverse-engineer what "npm 401" or "lockfile drift" means in this
// repository's context.
const CATEGORY_DESCRIPTIONS: Partial<Record<ReportCategoryKey, string>> = {
  'npm-auth-401':
    'The runner has no credentials for `npm.pkg.github.com`. Check the workflow\'s GitHub Packages auth setup (`NODE_AUTH_TOKEN` env + `NPM_CONFIG_USERCONFIG`).',
  'npm-forbidden-403':
    '`TARGET_REPO_PAT` (or whichever PAT feeds `NODE_AUTH_TOKEN`) lacks `Packages: Read` on the package\'s publisher repo, or the PAT is not SSO-authorized for the org.',
  'lockfile-drift':
    '`npm ci` refuses to install because `package.json` and `package-lock.json` disagree. Regenerate the lockfile against the Dependabot bump and re-run.',
  'peer-dep-conflict':
    'npm cannot resolve a peer dependency requirement. Either pin a compatible version or accept the Dependabot upgrade alongside its peer.',
  'missing-module':
    'An import points at a module that isn\'t resolvable from the installed dependency tree. Likely a stale import after a package rename or a removed export.',
  'type-error':
    'TypeScript compilation failed. Usually a breaking API change in the bumped package — update the call site.',
  'test-failure':
    'Unit/component tests failed after the merge. The bump may have changed runtime behavior; inspect the failing spec.',
  'install-error':
    'An npm install step failed for a reason that doesn\'t match the more specific categories above. Read the tail for the exact error code.',
  'build-error':
    'Production build (`vite build` / rollup) failed after the merge.',
  unknown:
    'No known failure pattern matched the validation output. Inspect the tail manually.',
  'merge-conflict':
    'The Dependabot branch conflicts with another change already on the integration branch (often another Dependabot PR that touched the same lockfile).',
  'push-workflow-scope':
    'GitHub refused the push because the PR modifies `.github/workflows/*` and the PAT lacks the `workflow` scope (classic) or `Actions: Write` permission (fine-grained). Either re-scope the PAT or merge these PRs manually outside the batch.',
  'push-branch-protection':
    'The integration branch is protected. Loosen the rule for the action\'s identity (e.g. an exemption or `Allow specified actors to bypass`) or change the integration branch naming pattern.',
  'push-other':
    'The push was rejected for a reason that doesn\'t match the known patterns. Inspect the message for the underlying git/GitHub error.',
};

export class ReportBuilder {
  build(params: {
    integrationBranch: string;
    baseBranch: string;
    results: PRResult[];
    finalSuite?: ValidationOutcome;
  }): string {
    const passed = params.results.filter((r) => r.status === 'PASS');
    const failed = params.results.filter((r) => r.status === 'FAIL');
    const categoryCounts = countFailureCategories(failed);

    return [
      `## Dependabot batch merge`,
      ``,
      `Integration branch: \`${params.integrationBranch}\` → \`${params.baseBranch}\``,
      `Processed: **${params.results.length}** · PASS: **${passed.length}** · FAIL: **${failed.length}**`,
      ``,
      this.categoryOverview(categoryCounts, failed.length),
      ``,
      this.summaryTable(params.results),
      ``,
      this.failureSection(failed),
      ``,
      this.finalSuiteSection(params.finalSuite),
      ``,
      this.passedPrsBlock(passed.map((r) => r.pr.number)),
    ]
      .filter((section) => section.length > 0)
      .join('\n');
  }

  static parsePassedPrNumbers(body: string): number[] {
    const start = body.indexOf(PASSED_PRS_BLOCK_START);
    const end = body.indexOf(PASSED_PRS_BLOCK_END);
    if (start === -1 || end === -1 || end < start) return [];
    const block = body.slice(start + PASSED_PRS_BLOCK_START.length, end);
    return block
      .split(/[,\s]+/)
      .map((token) => Number.parseInt(token, 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  private categoryOverview(
    counts: Map<string, { label: string; count: number }>,
    totalFailed: number,
  ): string {
    if (totalFailed === 0) return '';
    const lines = ['### Failure breakdown', '', '| Category | Count | What it means |', '| --- | ---: | --- |'];
    const entries = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [key, { label, count }] of entries) {
      const description = CATEGORY_DESCRIPTIONS[key as keyof typeof CATEGORY_DESCRIPTIONS] ?? '';
      lines.push(`| ${escapePipes(label)} | ${count} | ${escapePipes(description)} |`);
    }
    return lines.join('\n');
  }

  private summaryTable(results: PRResult[]): string {
    if (results.length === 0) return '_No Dependabot PRs were processed._';
    const header =
      '| PR | Title | Result | Category | Notes |\n| --- | --- | --- | --- | --- |';
    const rows = results.map((r) => {
      const icon = r.status === 'PASS' ? '✅' : '❌';
      let category = '';
      let note = '';
      if (r.status === 'PASS') {
        category = r.agentAttempt ? '🤖 agent-assisted' : '—';
      } else if (r.failure?.kind === 'merge-conflict') {
        category = 'merge conflict';
        note = `${r.failure.files.length} file(s) conflicted`;
      } else if (r.failure?.kind === 'validation-failed') {
        category = r.failure.categoryLabel;
        note = `exit ${r.failure.exitCode}: ${r.failure.cause}`;
      } else if (r.failure?.kind === 'push-rejected') {
        category = pushRejectLabel(r.failure.reason);
        note = r.failure.message;
      }
      return `| [#${r.pr.number}](${r.pr.htmlUrl}) | ${escapePipes(r.pr.title)} | ${icon} ${r.status} | ${escapePipes(category)} | ${escapePipes(note)} |`;
    });
    return [header, ...rows].join('\n');
  }

  private failureSection(failed: PRResult[]): string {
    if (failed.length === 0) return '';
    // Group by category so reviewers see "37 PRs failed on npm 401" as one
    // section instead of scrolling through 37 nearly-identical traces.
    const grouped = new Map<string, { label: string; results: PRResult[] }>();
    for (const r of failed) {
      const { key, label } = classifyResult(r);
      const bucket = grouped.get(key) ?? { label, results: [] };
      bucket.results.push(r);
      grouped.set(key, bucket);
    }

    const sections: string[] = ['## Failures'];
    const ordered = [...grouped.entries()].sort((a, b) => b[1].results.length - a[1].results.length);
    for (const [key, { label, results }] of ordered) {
      sections.push(this.categorySection(key, label, results));
    }
    return sections.join('\n\n');
  }

  private categorySection(key: string, label: string, results: PRResult[]): string {
    const description = CATEGORY_DESCRIPTIONS[key as keyof typeof CATEGORY_DESCRIPTIONS];
    const lines: string[] = [`### ${label} — ${results.length} PR(s)`];
    if (description) {
      lines.push('', `> ${description}`);
    }
    lines.push('');
    for (const r of results) {
      lines.push(this.failureEntry(r));
    }
    return lines.join('\n');
  }

  private failureEntry(r: PRResult): string {
    const head = `- [#${r.pr.number}](${r.pr.htmlUrl}) — ${r.pr.title}`;
    const agentBlock = r.agentAttempt ? this.agentAttemptBlock(r.agentAttempt) : '';
    if (r.failure?.kind === 'merge-conflict') {
      const files = r.failure.files.map((f) => `    - \`${f}\``).join('\n');
      return `${head}\n  Conflicting files:\n${files}${agentBlock}`;
    }
    if (r.failure?.kind === 'validation-failed') {
      return [
        head,
        `  - **Cause:** ${r.failure.cause}`,
        `  - **Exit code:** ${r.failure.exitCode}`,
        agentBlock,
        ``,
        `  <details><summary>Validation output (tail)</summary>`,
        ``,
        // The static/Claude analyzer renders its own details block as part of
        // the body; we strip the outer summary line and re-wrap inside the per-
        // category block to keep nesting predictable.
        r.failure.details,
        ``,
        `  </details>`,
      ].filter((l) => l !== undefined).join('\n');
    }
    if (r.failure?.kind === 'push-rejected') {
      return `${head}\n  - **Push rejected:** ${r.failure.message}${agentBlock}`;
    }
    return head;
  }

  private agentAttemptBlock(attempt: AgentAttempt): string {
    return [
      ``,
      `  <details><summary>Agent attempt — ${attempt.commitSha.slice(0, 7)} — ${escapePipes(attempt.summary)}</summary>`,
      ``,
      '  ```',
      attempt.outputTail || '(no output)',
      '  ```',
      ``,
      `  </details>`,
    ].join('\n');
  }

  private finalSuiteSection(outcome: ValidationOutcome | undefined): string {
    if (!outcome) return '';
    const icon = outcome.passed ? '✅' : '❌';
    return [
      `## Final suite re-run`,
      `${icon} exit code ${outcome.exitCode}`,
      ...(outcome.passed
        ? []
        : ['', '```', outcome.stderrTail || outcome.stdoutTail, '```']),
    ].join('\n');
  }

  private passedPrsBlock(numbers: number[]): string {
    return [PASSED_PRS_BLOCK_START, numbers.join(','), PASSED_PRS_BLOCK_END].join('\n');
  }
}

function countFailureCategories(
  failed: PRResult[],
): Map<string, { label: string; count: number }> {
  const counts = new Map<string, { label: string; count: number }>();
  for (const r of failed) {
    const { key, label } = classifyResult(r);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { label, count: 1 });
  }
  return counts;
}

function classifyResult(r: PRResult): { key: string; label: string } {
  if (r.failure?.kind === 'merge-conflict') {
    return { key: 'merge-conflict', label: 'merge conflict' };
  }
  if (r.failure?.kind === 'validation-failed') {
    return { key: r.failure.category, label: r.failure.categoryLabel };
  }
  if (r.failure?.kind === 'push-rejected') {
    return { key: `push-${pushKeyForReason(r.failure.reason)}`, label: pushRejectLabel(r.failure.reason) };
  }
  return { key: 'unknown', label: 'unknown' };
}

function pushKeyForReason(reason: 'workflow-scope-required' | 'branch-protection' | 'other'): string {
  switch (reason) {
    case 'workflow-scope-required':
      return 'workflow-scope';
    case 'branch-protection':
      return 'branch-protection';
    default:
      return 'other';
  }
}

function pushRejectLabel(reason: 'workflow-scope-required' | 'branch-protection' | 'other'): string {
  switch (reason) {
    case 'workflow-scope-required':
      return 'push rejected (workflow scope)';
    case 'branch-protection':
      return 'push rejected (branch protection)';
    default:
      return 'push rejected';
  }
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
