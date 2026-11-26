# Agent guide

## Verify your work

- `node scripts/control.mjs doctor`: checks Node, dependencies, git hooks and that you are on a work branch.
- `node scripts/control.mjs verify`: runs the root `typecheck`, `lint` and `test` scripts and reports each step. A full run that passes records the tree, so the next one on the same tree is skipped.
- `node scripts/control.mjs verify --changed [path...]`: the same scripts filtered to the given repo-relative paths, or to the diff against the merge-base plus untracked files, while you iterate. It does not record the tree: finish with a full `verify`.
- The Worker's D1 integration tests run inside `verify` (the `test` step, via `@cloudflare/vitest-pool-workers`); they need no database or Docker.
- Browser checks are not part of `verify`: `node_modules/.bin/playwright test` builds and serves the web app on port 4331.
- Known failure: `npm run lint` reports 10 errors in the untracked `videos/` folder (`window` and `document` not defined, one unused variable). They are not application code. Do not edit them to make `verify` green.

## Feature map

What the app does and how to exercise each part: [.claude/verification/features/README.md](.claude/verification/features/README.md). Ask the control CLI for the rest: `node scripts/control.mjs --help` lists `health`, `zones`, `cells`, `notice`, `report` (use `--dry-run` first, it writes) and `screenshot`.

## Branch policy

Work on a `feat/`, `fix/` or `hotfix/` branch off `develop`. The git hooks in `.githooks/` refuse commits on `develop` and `master`, and refuse commit messages that carry AI attribution. `master` is the Vercel production branch: merging to it deploys the web app.
