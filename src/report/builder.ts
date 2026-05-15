import type { PRResult, ValidationOutcome } from '../types';

const PASSED_PRS_BLOCK_START = '<!-- dependabot-batch-merge:passed-prs:start -->';
const PASSED_PRS_BLOCK_END = '<!-- dependabot-batch-merge:passed-prs:end -->';

export class ReportBuilder {
  build(params: {
    integrationBranch: string;
    baseBranch: string;
    results: PRResult[];
    finalSuite?: ValidationOutcome;
  }): string {
    const passed = params.results.filter((r) => r.status === 'PASS');
    const failed = params.results.filter((r) => r.status === 'FAIL');

    return [
      `## Dependabot batch merge`,
      ``,
      `Integration branch: \`${params.integrationBranch}\` → \`${params.baseBranch}\``,
      `Processed: **${params.results.length}** · PASS: **${passed.length}** · FAIL: **${failed.length}**`,
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

  private summaryTable(results: PRResult[]): string {
    if (results.length === 0) return '_No Dependabot PRs were processed._';
    const header = '| PR | Title | Result | Notes |\n| --- | --- | --- | --- |';
    const rows = results.map((r) => {
      const note =
        r.status === 'PASS'
          ? ''
          : r.failure?.kind === 'merge-conflict'
            ? `merge conflict (${r.failure.files.length} file(s))`
            : (r.failure?.summary ?? 'see details below');
      const icon = r.status === 'PASS' ? '✅' : '❌';
      return `| [#${r.pr.number}](${r.pr.htmlUrl}) | ${escapePipes(r.pr.title)} | ${icon} ${r.status} | ${escapePipes(note)} |`;
    });
    return [header, ...rows].join('\n');
  }

  private failureSection(failed: PRResult[]): string {
    if (failed.length === 0) return '';
    const sections = failed.map((r) => {
      const heading = `### ❌ #${r.pr.number} — ${r.pr.title}`;
      if (r.failure?.kind === 'merge-conflict') {
        return [
          heading,
          ``,
          `Merge conflict in:`,
          ...r.failure.files.map((f) => `- \`${f}\``),
        ].join('\n');
      }
      if (r.failure?.kind === 'validation-failed') {
        return [heading, ``, r.failure.details].join('\n');
      }
      return heading;
    });
    return ['## Failures', ...sections].join('\n\n');
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

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|');
}
