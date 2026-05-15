import type { DependabotPR, FailureExplanation, ValidationOutcome } from '../types';

export interface FailureAnalyzerInput {
  pr: DependabotPR;
  validation: ValidationOutcome;
}

export interface FailureAnalyzer {
  explain(input: FailureAnalyzerInput): Promise<FailureExplanation>;
}

export class StaticFailureAnalyzer implements FailureAnalyzer {
  async explain({ pr, validation }: FailureAnalyzerInput): Promise<FailureExplanation> {
    return {
      summary: `validation exited with code ${validation.exitCode}`,
      body:
        `Validation command failed for PR #${pr.number} (${pr.title}).\n\n` +
        `Exit code: ${validation.exitCode}\n\n` +
        '```\n' +
        (validation.stderrTail || validation.stdoutTail) +
        '\n```',
    };
  }
}
