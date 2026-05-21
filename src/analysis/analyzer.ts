import type { DependabotPR, FailureExplanation, ValidationOutcome } from '../types';
import { categorizeFailure } from './categorize';

export interface FailureAnalyzerInput {
  pr: DependabotPR;
  validation: ValidationOutcome;
}

export interface FailureAnalyzer {
  explain(input: FailureAnalyzerInput): Promise<FailureExplanation>;
}

export class StaticFailureAnalyzer implements FailureAnalyzer {
  async explain({ pr, validation }: FailureAnalyzerInput): Promise<FailureExplanation> {
    const { category, label, cause } = categorizeFailure(validation);
    const tail = validation.stderrTail || validation.stdoutTail || '(no output captured)';
    return {
      category,
      categoryLabel: label,
      cause,
      exitCode: validation.exitCode,
      summary: cause,
      body:
        `**Category:** ${label}\n` +
        `**Cause:** ${cause}\n` +
        `**Exit code:** ${validation.exitCode}\n` +
        `**PR:** #${pr.number} — ${pr.title}\n\n` +
        '<details><summary>Validation output (tail)</summary>\n\n' +
        '```\n' +
        tail +
        '\n```\n\n</details>',
    };
  }
}
