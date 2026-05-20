# dependabot-batch-merge

A GitHub Action that consolidates open Dependabot pull requests into a single integration branch, validates each merge with a configurable suite, opens one batch PR against the base branch, and (optionally, in a second pass) closes the original source PRs once that batch PR is merged.

Failures are explained by a Cursor Cloud agent when an API key is configured; otherwise a static "exit code + stderr tail" explanation is written into the batch PR body.

> **v1 scope.** The action is hard-locked to `Maersk-Global/ui-myfinance`. Any other `target-repo` value is rejected in `parseConfig`. Onboarding additional repositories is a deliberate follow-up that requires a code change and a new release. v1 also supports manual dispatch only — scheduled runs are a planned follow-up.

## How it works

1. Cuts an integration branch from `base-branch` (default `main`), force-pushed so same-day re-runs overwrite prior remote state.
2. Lists open PRs authored by Dependabot in `Maersk-Global/ui-myfinance`, oldest first, capped at `max-prs`.
3. For each PR: merges into the integration branch with `--no-ff`, then runs the configured validation command.
   - **PASS** → push the integration branch and continue.
   - **FAIL** → ask the failure analyzer to explain. Then either `skip` (drop the merge with `reset --hard HEAD~1`) or `revert-commit` (keep the merge, append a `git revert`), and continue.
4. Optionally re-runs the validation suite on the integration branch tip to catch cross-PR interactions.
5. Opens or updates a draft batch PR against `base-branch`. The PR body contains a live results table, a per-failure section, and a machine-readable list of PASSed source PR numbers (used by `close-sources` mode).
6. After the batch PR is merged to `main`, the workflow is dispatched again with `mode: close-sources` and `close-source-prs: true` to close the original Dependabot PRs with a "Superseded by #X" comment.

Source Dependabot PRs are not closed automatically when their changes land on `main` via another PR ([dependabot/dependabot-core#3880](https://github.com/dependabot/dependabot-core/issues/3880)). The two-mode design exists to handle that gap explicitly and opt-in.

## Architecture: central orchestrator

This repository **is** the workflow host. There is no consumer-side workflow. The `Maersk-Global/ui-myfinance` repository does not need any file added to it — it just needs to grant the central PAT read/write access to its contents and pull requests.

```
┌────────────────────────────────────────┐
│ obaDev95/dependabot-batch-merge        │
│                                        │
│  .github/workflows/batch.yml           │
│    workflow_dispatch  ──┐              │
│                         │              │
│  src/  (Node.js action) │              │
│    invoked via          ▼              │
│    uses: ./@main                       │
│                                        │
└──────────────────┬─────────────────────┘
                   │ checks out, merges PRs,
                   │ opens batch PR, optionally
                   │ closes source PRs
                   ▼
┌────────────────────────────────────────┐
│ Maersk-Global/ui-myfinance             │
│   (target repo — only grants PAT       │
│    access; no workflow file needed)    │
└────────────────────────────────────────┘
```

## Running the workflow

From this repository's **Actions → Dependabot batch merge → Run workflow**:

| Dispatch input | Type | Default | When to change |
| --- | --- | --- | --- |
| `target-repo` | string | `Maersk-Global/ui-myfinance` | Don't — any other value is rejected in v1. |
| `validation-command` | string | `npm ci && npm run typecheck && npm test && npm run build` | If the target's validation differs. |
| `mode` | choice | `batch` | Switch to `close-sources` after the batch PR is merged. |
| `close-source-prs` | boolean | `false` | Tick when running `mode: close-sources` to actually close the source PRs. Ignored in `mode: batch`. |

### Typical run sequence

1. **First dispatch** — `mode: batch`. The action opens (or updates) a draft batch PR with the merge results.
2. Review and merge the batch PR yourself, the same way you'd merge any chore PR.
3. **Second dispatch** — `mode: close-sources`, `close-source-prs: ✓`. The action finds the most recently merged batch PR, reads its machine-readable PASSed-PRs block, and closes each of those source PRs with a "Superseded by #X" comment.

## Required secrets (on **this** repo)

| Secret | Required | Purpose |
| --- | --- | --- |
| `TARGET_REPO_PAT` | yes | PAT with **Contents: RW** and **Pull requests: RW** on `Maersk-Global/ui-myfinance`. Used both for `actions/checkout` and for the action's GitHub API calls. |
| `NPMRC_CONTENTS` | optional | Full `.npmrc` contents for private npm registries. Written to `~/.npmrc` (mode 600) before the validation command runs. |
| `CURSOR_API_KEY` | optional | Cursor Cloud API key. Without it, validation failures fall back to a static explanation (exit code + stderr tail). |

## Action inputs (full list)

These are the inputs the underlying action accepts. `batch.yml` only surfaces the subset that is useful to vary per dispatch — the rest stick to safe defaults.

| Input | Default | Description |
| --- | --- | --- |
| `target-repo` | _(required)_ | Hard-locked to `Maersk-Global/ui-myfinance` in v1. |
| `mode` | `batch` | `batch` (merge loop) or `close-sources` (close PASSed source PRs after the batch PR is merged). |
| `validation-command` | _(required when `mode=batch`)_ | Shell command run after each merge. Runs through `bash -lc`. |
| `base-branch` | `main` | Branch the integration branch is cut from and the batch PR targets. |
| `integration-branch-prefix` | `chore/dependabot-batch` | Prefix of the integration branch. A `-YYYY-MM-DD` suffix is appended. |
| `dependabot-author` | `dependabot[bot]` | Login used to identify Dependabot PRs. |
| `on-failure` | `skip` | `skip` drops a failed merge; `revert-commit` keeps it and appends a revert. |
| `re-run-final-suite` | `true` | Re-run validation on the integration branch tip before opening the batch PR. |
| `draft-pr` | `true` | Open the batch PR as a draft. |
| `max-prs` | `20` | Safety cap on PRs processed per run. |
| `close-source-prs` | `false` | In `mode=close-sources`, close PASSed source PRs with a "Superseded by" comment. |
| `cursor-api-key` | _(optional)_ | Cursor Cloud API key. |
| `github-token` | `${{ github.token }}` | Token for the GitHub API. The central workflow passes `TARGET_REPO_PAT`. |

## Outputs

| Output | Description |
| --- | --- |
| `batch-pr-number` | Number of the batch PR opened or updated. Empty string if no PR was opened (e.g. all candidates failed and were skipped). |
| `batch-pr-url` | URL of the batch PR. Empty string if no PR was opened. |
| `pass-count` | Number of source PRs that PASSed validation. |
| `fail-count` | Number of source PRs that FAILed validation. |

## Repository layout

```
src/
  index.ts                 entry point, wires up dependencies
  orchestrator.ts          BatchOrchestrator — top-level coordinator
  close-sources.ts         CloseSourcesOrchestrator
  config.ts                Input parsing + v1 target-repo hard-lock
  github/                  Octokit-backed PR listing and PR writing
  git/                     git CLI wrappers (branch management, merge/revert)
  validation/              ValidationRunner interface + command-based impl
  analysis/                FailureAnalyzer interface + Cursor Cloud impl
  report/                  Markdown report + PASSed-PR machine block
tests/                     Vitest unit tests
.github/workflows/
  batch.yml                The central orchestrator
  ci.yml                   This repo's own CI
action.yml                 Action metadata (used directly by batch.yml)
dist/index.js              Committed bundle (ncc-built; required by node20 runtime)
```

## Cursor Cloud integration

`CursorFailureAnalyzer` posts to `https://api.cursor.com/v0/agents/runs` with a JSON body and falls back to a static explanation if the call fails. **The exact endpoint shape should be confirmed against the Cursor Cloud documentation before relying on it in production.** Only the `callCursor` method needs adjustment — the rest of the orchestration is insulated behind the `FailureAnalyzer` interface.

## Local development

```bash
npm install
npm run typecheck
npm test
npm run build      # bundles to dist/index.js (committed for the Action runtime)
```

CI also verifies that `dist/` is up to date — re-run `npm run build` and commit the result before pushing source changes.

## Expanding scope beyond v1

When another team is ready to onboard:

1. Replace the single `V1_ALLOWED_TARGET_REPO` constant in `src/config.ts` with an allowlist (env-driven or input-driven) and adapt `resolveTargetRepo`.
2. Update `action.yml` and `.github/workflows/batch.yml` input descriptions and defaults.
3. Update this README's "v1 scope" callout.
4. Cut a new release tag.

Keeping the hard-lock in code rather than relying on workflow-level convention means scope expansion is explicit and reviewable in a single PR.
