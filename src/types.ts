export type Mode = 'batch' | 'close-sources';

export type FailureHandling = 'skip' | 'revert-commit';

export interface BatchConfig {
  mode: 'batch';
  baseBranch: string;
  integrationBranchPrefix: string;
  dependabotAuthor: string;
  validationCommand: string;
  onFailure: FailureHandling;
  reRunFinalSuite: boolean;
  draftPr: boolean;
  maxPrs: number;
  owner: string;
  repo: string;
}

export interface CloseSourcesConfig {
  mode: 'close-sources';
  baseBranch: string;
  integrationBranchPrefix: string;
  owner: string;
  repo: string;
}

export type RunConfig = BatchConfig | CloseSourcesConfig;

export interface DependabotPR {
  number: number;
  title: string;
  headRef: string;
  headSha: string;
  htmlUrl: string;
  createdAt: string;
}

export type PRStatus = 'PASS' | 'FAIL';

export type PushRejectReason = 'workflow-scope-required' | 'branch-protection' | 'other';

export type FailureReason =
  | { kind: 'merge-conflict'; files: string[] }
  | {
      kind: 'validation-failed';
      category: import('./analysis/categorize').FailureCategory;
      categoryLabel: string;
      cause: string;
      exitCode: number;
      summary: string;
      details: string;
    }
  | {
      kind: 'push-rejected';
      reason: PushRejectReason;
      message: string;
    };

export interface PRResult {
  pr: DependabotPR;
  status: PRStatus;
  failure?: FailureReason;
}

export interface ValidationOutcome {
  passed: boolean;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface MergeOutcome {
  kind: 'merged' | 'conflict';
  conflictedFiles?: string[];
}

export interface FailureExplanation {
  category: import('./analysis/categorize').FailureCategory;
  categoryLabel: string;
  cause: string;
  exitCode: number;
  summary: string;
  body: string;
}

export interface BatchSummary {
  batchPrNumber?: number;
  batchPrUrl?: string;
  results: PRResult[];
  finalSuite?: ValidationOutcome;
}
