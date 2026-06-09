import type { ValidationOutcome } from '../types';

// Categories ordered by specificity: the categorize() function returns the
// first match, so put narrower patterns above broader ones (e.g. lockfile
// drift before generic "install-error", npm-auth-401 before "install-error").
export type FailureCategory =
  | 'npm-auth-401'
  | 'npm-forbidden-403'
  | 'lockfile-drift'
  | 'peer-dep-conflict'
  | 'missing-module'
  | 'type-error'
  | 'test-failure'
  | 'install-error'
  | 'build-error'
  | 'unknown';

export interface CategorizedFailure {
  category: FailureCategory;
  label: string;
  cause: string;
}

const LABELS: Record<FailureCategory, string> = {
  'npm-auth-401': 'npm 401 (auth missing)',
  'npm-forbidden-403': 'npm 403 (insufficient scope)',
  'lockfile-drift': 'lockfile drift',
  'peer-dep-conflict': 'peer dependency conflict',
  'missing-module': 'missing module',
  'type-error': 'type error',
  'test-failure': 'test failure',
  'install-error': 'install error',
  'build-error': 'build error',
  unknown: 'unknown',
};

interface Rule {
  category: FailureCategory;
  test: RegExp;
  // Optional refiner that extracts a one-line cause from the matched output;
  // falls back to the default label-derived string when omitted.
  refine?: (text: string) => string | undefined;
}

const RULES: Rule[] = [
  {
    category: 'npm-auth-401',
    test: /401 Unauthorized[\s\S]*?npm\.pkg\.github\.com|authentication token not provided/i,
    refine: (text) => {
      const m = text.match(/GET\s+(https:\/\/npm\.pkg\.github\.com\/\S+)/);
      return m
        ? `npm.pkg.github.com 401 fetching ${m[1]} — runner has no auth token`
        : 'npm.pkg.github.com 401 — runner has no auth token';
    },
  },
  {
    category: 'npm-forbidden-403',
    test: /403 Forbidden[\s\S]*?npm\.pkg\.github\.com|does not match expected scopes/i,
    refine: (text) => {
      const m = text.match(/GET\s+(https:\/\/npm\.pkg\.github\.com\/\S+)/);
      return m
        ? `npm.pkg.github.com 403 fetching ${m[1]} — PAT lacks Packages:Read on publisher repo`
        : 'npm.pkg.github.com 403 — PAT lacks Packages:Read on publisher repo';
    },
  },
  {
    category: 'lockfile-drift',
    test: /npm ci can only install packages when your package\.json and package-lock\.json|EUSAGE\b[\s\S]*?package-lock\.json/i,
    refine: () => 'package.json and package-lock.json are out of sync',
  },
  {
    category: 'peer-dep-conflict',
    test: /ERESOLVE|EPEERINVALID|peer dep(?:endency)? (?:missing|conflict)/i,
    refine: (text) => {
      const m = text.match(/peer\s+(\S+@\S+)/i);
      return m ? `peer dependency conflict on ${m[1]}` : 'peer dependency conflict (ERESOLVE)';
    },
  },
  {
    category: 'missing-module',
    test: /Cannot find module ['"]([^'"]+)['"]|Module not found:[\s\S]*?['"]([^'"]+)['"]/i,
    refine: (text) => {
      const m =
        text.match(/Cannot find module ['"]([^'"]+)['"]/) ??
        text.match(/Module not found:[\s\S]*?['"]([^'"]+)['"]/);
      return m ? `cannot resolve "${m[1]}"` : 'cannot resolve a module import';
    },
  },
  {
    category: 'type-error',
    test: /\berror TS\d+:/,
    refine: (text) => {
      const m = text.match(/(\S+\.(?:ts|vue|tsx))(?::\d+:\d+)?\s*-\s*error TS\d+:\s*([^\n]+)/);
      if (m && m[1] && m[2]) return `TS error in ${m[1]}: ${m[2].trim()}`;
      return 'TypeScript compilation failed';
    },
  },
  {
    category: 'test-failure',
    test: /\bTests?\s*:?\s*\d+\s*failed|\bFAIL\s+\S+\.(?:spec|test)\.(?:ts|tsx|js|jsx|vue)\b|\bSnapshots?\s*:?\s*\d+\s*failed|Snapshot\s+`[^`]+`\s+(?:mismatched|did not match)|\b\d+\s+failing\b|AssertionError\b/i,
    refine: (text) => {
      const snapshot = text.match(/Snapshot\s+`([^`]+)`\s+(?:mismatched|did not match)/i);
      if (snapshot) return `snapshot "${snapshot[1]}" mismatched`;
      const vitestTests = text.match(/Tests?\s*:?\s*(\d+)\s*failed[^,\n]*(?:,\s*(\d+)\s*passed)?/i);
      if (vitestTests) {
        const failed = vitestTests[1];
        const passed = vitestTests[2];
        return passed
          ? `${failed} test(s) failed (${passed} passed)`
          : `${failed} test(s) failed`;
      }
      const vitestSnaps = text.match(/Snapshots?\s*:?\s*(\d+)\s*failed/i);
      if (vitestSnaps) return `${vitestSnaps[1]} snapshot(s) failed`;
      const file = text.match(/\bFAIL\s+(\S+\.(?:spec|test)\.(?:ts|tsx|js|jsx|vue))/);
      return file ? `test file failed: ${file[1]}` : 'one or more tests failed';
    },
  },
  {
    category: 'install-error',
    test: /^npm (?:ERR!|error)\s/m,
    refine: (text) => {
      const codeMatch = text.match(/npm (?:ERR!|error) code (E[A-Z]+)/);
      const msgMatch = text.match(/npm (?:ERR!|error)\s+([^\n]+)/);
      const code = codeMatch?.[1];
      const msg = msgMatch?.[1]?.trim();
      if (code && msg) return `npm ${code}: ${truncate(msg, 140)}`;
      if (code) return `npm ${code}`;
      if (msg) return `npm error: ${truncate(msg, 140)}`;
      return 'npm install failed';
    },
  },
  {
    category: 'build-error',
    test: /\bvite build\b[\s\S]*?error|Rollup\s+failed|Build failed/i,
    refine: () => 'production build failed',
  },
];

export function categorizeFailure(validation: ValidationOutcome): CategorizedFailure {
  // ANSI escapes from coloured tooling output (vitest, npm) defeat ^/$
  // anchors and \b boundaries — strip them before matching. Without this,
  // vitest's `FAIL <path>` line is preceded by SGR codes on the same line
  // and the regex misses every snapshot/test failure.
  const raw = `${validation.stderrTail || ''}\n${validation.stdoutTail || ''}`;
  const text = stripAnsi(raw);
  for (const rule of RULES) {
    if (rule.test.test(text)) {
      const cause = rule.refine?.(text) ?? LABELS[rule.category];
      return { category: rule.category, label: LABELS[rule.category], cause };
    }
  }
  return {
    category: 'unknown',
    label: LABELS.unknown,
    cause: `validation exited with code ${validation.exitCode}`,
  };
}

// Matches CSI (Control Sequence Introducer) and OSC sequences. Sufficient
// for vitest/npm/git tooling output; not a general-purpose ANSI parser.
const ANSI_PATTERN = /\[[0-9;?]*[A-Za-z]|\][^]*(?:|\\)/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
