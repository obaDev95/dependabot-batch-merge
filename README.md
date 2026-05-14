# dependabot-batch-merge

A reusable GitHub Action that consolidates open Dependabot pull requests into a single integration branch, validates each merge, and opens one batch PR against the base branch. Failures are explained by a Cursor Cloud agent.

> v1 supports manual dispatch only. Scheduled runs are a planned follow-up.

## How it works

1. Cuts an integration branch from `base-branch` (default `main`).
2. Lists open PRs authored by Dependabot, oldest first.
3. For each PR: merges into the integration branch, runs the configured validation command.
   - **PASS** → keep the merge, push, continue.
   - **FAIL** → ask Cursor to explain the failure, drop the merge (`skip`) or add a revert commit (`revert-commit`), continue.
4. Optionally re-runs the validation suite on the integration branch tip to catch cross-PR interactions.
5. Opens (or updates) a draft batch PR. The PR body contains a live results table and a machine-readable list of PASSed source PRs.
6. After you merge the batch PR to `main`, dispatch the workflow again with `mode: close-sources` to close the original Dependabot PRs.

Source Dependabot PRs are not closed automatically when their changes land on `main` via another PR ([dependabot/dependabot-core#3880](https://github.com/dependabot/dependabot-core/issues/3880)). The two-mode design exists to handle that gap explicitly and opt-in.

## Adoption (one file in the consuming repo)

```yaml
# .github/workflows/dependabot-batch.yml
name: Dependabot batch merge
on:
  workflow_dispatch:
    inputs:
      mode:
        type: choice
        options: [batch, close-sources]
        default: batch
      close-source-prs:
        type: boolean
        default: false

jobs:
  run:
    uses: obaDev95/dependabot-batch-merge/.github/workflows/batch.yml@v1
    with:
      validation-command: 'npm ci && npm run lint && npm test && npm run build'
      mode: ${{ inputs.mode }}
      close-source-prs: ${{ inputs.close-source-prs && 'true' || 'false' }}
    secrets:
      CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `mode` | `batch` | `batch` (run the merge loop) or `close-sources` (close PASSed source PRs after the batch PR is merged). |
| `validation-command` | _(required when `mode=batch`)_ | Shell command run after each merge to validate. |
| `base-branch` | `main` | Branch the integration branch is cut from and the batch PR targets. |
| `integration-branch-prefix` | `chore/dependabot-batch` | Prefix of the integration branch (date suffix is appended). |
| `dependabot-author` | `dependabot[bot]` | Login used to identify Dependabot PRs. |
| `on-failure` | `skip` | `skip` drops the failed merge; `revert-commit` keeps it and adds a revert. |
| `re-run-final-suite` | `true` | Re-run validation on the integration branch tip before opening the batch PR. |
| `draft-pr` | `true` | Open the batch PR as a draft. |
| `max-prs` | `20` | Safety cap on PRs processed per run. |
| `close-source-prs` | `false` | In `mode=close-sources`, close PASSed source PRs with a "Superseded by" comment. |

Required secret: `CURSOR_API_KEY` (optional — without it, failure explanations fall back to the raw exit code + stderr tail).

## Repository layout

```
src/
  orchestrator.ts          BatchOrchestrator — top-level coordinator
  close-sources.ts         CloseSourcesOrchestrator
  config.ts                Input parsing
  github/                  Octokit-backed PR listing and PR writing
  git/                     git CLI wrappers (branch management, merge/revert)
  validation/              ValidationRunner interface + command-based impl
  analysis/                FailureAnalyzer interface + Cursor Cloud impl
  report/                  Markdown report + PASSed-PR machine block
tests/                     Vitest unit tests
.github/workflows/
  batch.yml                Reusable workflow consumed by other repos
  ci.yml                   This repo's own CI
action.yml                 Action metadata
```

## Permissions required in the consumer workflow

```yaml
permissions:
  contents: write          # create integration branch, push merges
  pull-requests: write     # open and update the batch PR, close source PRs
```

## Cursor Cloud integration

The current `CursorFailureAnalyzer` posts to `https://api.cursor.com/v0/agents/runs` with a JSON body and falls back to a static explanation if the call fails. **The exact endpoint shape should be confirmed against the Cursor Cloud documentation before relying on it in production.** Only the `callCursor` method needs adjustment — the rest of the orchestration is insulated behind the `FailureAnalyzer` interface.

## Local development

```bash
npm install
npm run typecheck
npm test
npm run build      # bundles to dist/index.js (committed for the Action runtime)
```
