# Contributing to SpecForge

## 1. Welcome / Purpose
Thanks for contributing to SpecForge.

SpecForge is building a disciplined, specification-driven engineering workflow. Contributions should keep scope clear, behavior deterministic, and diffs easy to review.

SpecForge is licensed under Apache License 2.0, which allows commercial and non-commercial use, modification, and distribution while preserving attribution and patent rights.

## 2. Development Setup
1. Use Node.js `>=22` and `pnpm`.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Run local validation:
   ```bash
   pnpm test
   pnpm typecheck
   pnpm build
   pnpm ci:policy
   ```

## 3. How to Choose an Issue
1. Check existing issues and milestones first to avoid duplicate work.
2. Start from the Development Tracker issue and project board:
   - Development Tracker: <https://github.com/iKwesi/SpecForge/issues/54>
   - Project Board: <https://github.com/users/iKwesi/projects/1>
3. Prefer scoped issues that are clearly bounded and testable.
4. If unclear, comment on the issue before implementation.

## 4. Branch Workflow
1. External contributors should work from a GitHub fork, not from branches pushed directly to the upstream repository.
2. Fork `iKwesi/SpecForge`, clone your fork locally, and add the upstream remote:
   ```bash
   git clone <your-fork-url>
   cd SpecForge
   git remote add upstream https://github.com/iKwesi/SpecForge.git
   ```
3. Sync from `upstream/main` before creating a branch:
   ```bash
   git fetch upstream
   git checkout main
   git pull --ff-only upstream main
   ```
4. Create a single-purpose branch from `main` (`feat/...`, `fix/...`, `docs/...`, `chore/...`).
5. Push the branch to your fork and open a PR against `main`.
6. Keep changes minimal and focused to one concern.
7. Respect the minimal diff policy: avoid unrelated refactors.
8. Direct commits to `main` are discouraged/prohibited except by explicit maintainer override.

## 5. Commit Message Standard
Use Conventional Commits where possible.

Examples:
- `feat(planning): add spec-pack index resolver`
- `fix(cli): handle missing project mode input`
- `docs(readme): add contribution links`
- `test(core): add artifact reference mismatch coverage`
- `chore(ci): tighten cache key strategy`

## 6. Pull Request Expectations
Each PR should include:
1. A concise summary of what changed.
2. A linked issue (or rationale if none exists). Use `Closes #<issue>` when appropriate.
3. Why the change is needed.
4. Risk/impact notes for reviewers.
5. Evidence that tests/checks were run.
6. A PR target of `main`, opened from a feature branch or fork branch.

## 7. Testing Expectations
1. Run `pnpm test` locally for all changes.
2. Run `pnpm typecheck` for TypeScript changes.
3. Run `pnpm build` when touching build-relevant code.
4. Run `pnpm ci:policy` when touching policy, CI, or contribution-gate behavior.
5. Add or update tests when behavior changes.
6. GitHub Actions must pass before a PR can merge to `main`.

## 8. Documentation Expectations
1. Update docs when behavior, commands, or contributor workflows change.
2. Keep updates concise and aligned with current repo scope.
3. Do not rewrite large docs unless required for correctness.

## 9. Communication / Discussion Expectations
1. Use issue comments for scope and design clarifications.
2. Call out assumptions and tradeoffs early.
3. Keep discussion technical, respectful, and evidence-based.
4. Prefer explicit decisions over implied intent.
5. If you want to work on an issue, leave a comment first so maintainers can confirm there is no overlap.

## 10. Terminology Conventions
Use these terms consistently in code and docs:

- operation:
  - an internal deterministic workflow component in SpecForge core
  - examples: `operation.ideaInterview`, `operation.generatePRD`, `operation.generateSpecPack`

- skill:
  - an external reusable capability plugin sourced from built-ins, verified providers, or user-installed packages
  - skills are orchestrated through the Skill Registry layer

Do not label internal runtime operations as skills.

## 11. Merge Policy
1. `main` uses protected pull requests, required CI checks, and linear history.
2. Merge commits are not allowed on `main`.
3. Maintainers should use `Squash and merge` by default.
4. `Rebase and merge` is acceptable when preserving multiple intentional commits is important.
5. Outside contributors do not merge to `main`; maintainers handle the final merge after review and CI.
