import { describe, expect, it } from 'vitest';
import { categorizeFailure } from '../src/analysis/categorize';
import type { ValidationOutcome } from '../src/types';

function outcome(partial: Partial<ValidationOutcome> & Pick<ValidationOutcome, 'exitCode'>): ValidationOutcome {
  return {
    passed: false,
    stdoutTail: '',
    stderrTail: '',
    ...partial,
  };
}

describe('categorizeFailure', () => {
  it('detects npm 401 auth missing', () => {
    const result = categorizeFailure(
      outcome({
        exitCode: 1,
        stderrTail: '401 Unauthorized\nGET https://npm.pkg.github.com/@maersk-global/foo',
      }),
    );
    expect(result.category).toBe('npm-auth-401');
    expect(result.cause).toContain('401');
  });

  it('detects npm 403 forbidden', () => {
    const result = categorizeFailure(
      outcome({
        exitCode: 1,
        stderrTail: '403 Forbidden\nGET https://npm.pkg.github.com/@maersk-global/foo',
      }),
    );
    expect(result.category).toBe('npm-forbidden-403');
  });

  it('detects lockfile drift', () => {
    const result = categorizeFailure(
      outcome({
        exitCode: 1,
        stderrTail:
          'npm ci can only install packages when your package.json and package-lock.json are in sync',
      }),
    );
    expect(result.category).toBe('lockfile-drift');
  });

  it('detects peer dependency conflict', () => {
    const result = categorizeFailure(
      outcome({ exitCode: 1, stderrTail: 'npm ERR! code ERESOLVE\npeer react@18 missing' }),
    );
    expect(result.category).toBe('peer-dep-conflict');
  });

  it('detects missing module', () => {
    const result = categorizeFailure(
      outcome({ exitCode: 1, stderrTail: "Cannot find module '@foo/bar'" }),
    );
    expect(result.category).toBe('missing-module');
    expect(result.cause).toContain('@foo/bar');
  });

  it('detects type error', () => {
    const result = categorizeFailure(
      outcome({
        exitCode: 1,
        stdoutTail: 'src/app.ts:10:5 - error TS2322: Type string is not assignable',
      }),
    );
    expect(result.category).toBe('type-error');
  });

  it('detects test failure with ANSI stripped', () => {
    const result = categorizeFailure(
      outcome({
        exitCode: 1,
        stdoutTail: '\x1b[31mFAIL\x1b[0m src/foo.spec.ts\nTests: 1 failed, 2 passed',
      }),
    );
    expect(result.category).toBe('test-failure');
  });

  it('detects install error', () => {
    const result = categorizeFailure(
      outcome({ exitCode: 1, stderrTail: 'npm ERR! code ENOTFOUND\nnpm ERR! network' }),
    );
    expect(result.category).toBe('install-error');
  });

  it('detects build error', () => {
    const result = categorizeFailure(
      outcome({ exitCode: 1, stderrTail: 'vite build error\nRollup failed to resolve import' }),
    );
    expect(result.category).toBe('build-error');
  });

  it('falls back to unknown', () => {
    const result = categorizeFailure(outcome({ exitCode: 42, stderrTail: 'something unexpected' }));
    expect(result.category).toBe('unknown');
    expect(result.cause).toContain('42');
  });
});
