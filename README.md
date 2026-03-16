# SpecForge

[![CI](https://github.com/iKwesi/SpecForge/actions/workflows/ci.yml/badge.svg)](https://github.com/iKwesi/SpecForge/actions/workflows/ci.yml)

SpecForge is a specification-driven engineering CLI for turning ideas, repository context, and review state into deterministic, artifact-backed workflows.

It treats software engineering more like a build system than a chat session: inspect the repository, generate explicit artifacts, explain lineage, apply policy, and keep status observable.

| [Golden Demo](./docs/GOLDEN_DEMO.md) | [Policy Configuration](./docs/POLICY_CONFIG.md) | [Architecture](./docs/ARCHITECTURE.md) | [Roadmap](./ROADMAP.md) | [Contributing](./CONTRIBUTING.md) |
| --- | --- | --- | --- | --- |

## Why SpecForge

Most engineering assistants are optimized for fast answers. SpecForge is optimized for disciplined change.

It is built around a few strong ideas:

- deterministic artifacts over hidden state
- bounded repository inspection over unscoped codebase guessing
- explainable planning and execution over opaque orchestration
- conservative policy and approval boundaries over silent autonomy
- provider adapters and skill boundaries over one giant monolith

If you care about traceability, reproducibility, and reviewable outputs, that tradeoff is the point.

## What You Can Do Today

SpecForge already has a meaningful local workflow surface.

- `specforge doctor`
  - validate Node, pnpm, git, repository readiness, and policy shape before work begins
- `specforge inspect`
  - profile an existing repository and write bounded architecture artifacts under `.specforge/`
  - optionally refresh maintained architecture docs and Mermaid diagrams
- `specforge explain`
  - render evidence-based explanations from artifact lineage plus optional policy and scheduler context
- `specforge status`
  - read review-request state and CI outcomes from GitHub or GitLab
  - optionally emit webhook notifications for status events
- `pnpm demo:golden`
  - run the canonical end-to-end demo and write a regression manifest

Under the hood, the repo also includes the core planning and execution primitives needed for:

- idea interview and PRD generation
- spec pack generation and validation
- work-graph decomposition and context-pack building
- conservative scheduling and workspace isolation
- bounded repair loops and replay/drift diagnostics
- skill registry, selection policy, built-ins, and external skill-pack adapters

## Current Status

SpecForge is in a strong source-first developer preview state.

What that means in practice:

- the core v1 and v1.1 foundations are implemented
- the CLI is usable locally today
- the repo has good automated coverage and a canonical demo path
- the remaining open issues are mostly future or research-oriented
- the package is not published to npm yet

This is a good point to evaluate the product, test workflows, and refine user experience before packaging it for broader installation.

## Install From Source

### Prerequisites

- Node.js `>=22`
- `pnpm`
- `git`
- optional: `gh` for GitHub-backed `status`
- optional: `glab` for GitLab-backed `status`

### Setup

```bash
git clone https://github.com/iKwesi/SpecForge.git
cd SpecForge
pnpm install
pnpm build
node dist/cli.js --help
```

For local development without a build step:

```bash
pnpm exec tsx src/cli.ts --help
```

Note:

- the current install path is source-first
- `package.json` still marks the project as private
- build `dist/` locally before relying on the packaged CLI entrypoint

## Quickstart

### 1. Validate your environment

```bash
node dist/cli.js doctor
```

Use this first. It checks the runtime/tooling surface and fails clearly when something important is missing or malformed.

### 2. Inspect an existing repository

```bash
node dist/cli.js inspect --repository-root . --artifact-dir .
```

This writes bounded repository artifacts such as:

- `.specforge/repo_profile.json`
- `.specforge/architecture_summary.json`

For a deeper bounded scan:

```bash
node dist/cli.js inspect --repository-root . --artifact-dir . --deep
```

To refresh maintained architecture docs from inspect artifacts:

```bash
node dist/cli.js inspect --repository-root . --artifact-dir . --write-architecture-docs
```

That can update:

- `.specforge/architecture_summary.md`
- `docs/ARCHITECTURE.md`

### 3. Explain an artifact

```bash
node dist/cli.js explain --artifact-file path/to/artifact.json
```

Use this when you need a human-readable explanation grounded in artifact lineage instead of reverse-engineering the workflow by hand.

### 4. Check review-request status

GitHub:

```bash
node dist/cli.js status --repo iKwesi/SpecForge --pr 123
node dist/cli.js status --pr https://github.com/iKwesi/SpecForge/pull/123
node dist/cli.js status --repo iKwesi/SpecForge --pr feat/task-1
```

GitLab:

```bash
node dist/cli.js status --provider gitlab --repo gitlab-org/cli --pr 42
node dist/cli.js status --pr https://gitlab.example.com/group/project/-/merge_requests/42
```

Webhook notification:

```bash
node dist/cli.js status --repo iKwesi/SpecForge --pr 123 --notify-webhook https://hooks.example.test/specforge
```

### 5. Run the canonical end-to-end demo

```bash
pnpm demo:golden
```

The golden demo is the fastest way to see the current product story end to end.
It exercises repository inspection, artifact generation, explainability, task execution artifacts, and status reporting in one repeatable flow.

See [docs/GOLDEN_DEMO.md](./docs/GOLDEN_DEMO.md) for the full walkthrough.

## Commands

In the table below, `specforge ...` refers to the built CLI command. From a source checkout, run the same commands as `node dist/cli.js ...` after `pnpm build`, or use `pnpm exec tsx src/cli.ts ...` during development.

| Command | Purpose | Notes |
| --- | --- | --- |
| `specforge doctor` | Validate environment, repository readiness, and policy shape | Good first command on any machine |
| `specforge inspect` | Produce repository profile and architecture artifacts | Supports `--deep`, `--dry-run`, and `--write-architecture-docs` |
| `specforge explain` | Explain artifact lineage and supporting evidence | Reads one or more artifact files plus optional policy/schedule files |
| `specforge status` | Report PR/MR state and CI outcomes | Supports GitHub, GitLab, and webhook notifications |
| `pnpm demo:golden` | Run the canonical existing-repo workflow | Best end-to-end evaluation path today |

## Core Concepts

### Artifacts

Artifacts are first-class outputs with ids, versions, lineage, generators, and checksums.
That gives SpecForge a concrete execution history instead of relying on transient chat memory.

### Operations

Operations are the deterministic core workflow units inside the engine.
Examples include repository profiling, PRD generation, spec-pack generation, planning, validation, and bounded repair loops.

### Skills

Skills are reusable capability plugins behind a registry and selection-policy boundary.
SpecForge already has:

- a skill registry
- built-in skill bootstrap
- selection policy
- external skill-pack/provider adapter foundations

### Policy

Policy is part of product behavior, not an afterthought.
Current policy surface includes:

- changed-lines coverage enforcement
- conservative parallelism defaults
- gate applicability by project mode

See [docs/POLICY_CONFIG.md](./docs/POLICY_CONFIG.md) for the current contract and example configuration.

## Repository Structure

```text
src/
  cli.ts                     CLI entrypoint
  core/
    operations/              Deterministic workflow primitives
    diagnostics/             doctor, inspect, explain, status, risk, replay/drift
    execution/               scheduler and workspace isolation
    skills/                  registry, built-ins, selection, external adapters
    trackers/                provider-agnostic issue-tracker contracts
    git/                     native git provider abstractions
    github/                  GitHub issue-tracker provider
    gitlab/                  GitLab issue-tracker provider
    notifiers/               outbound status notification adapters
  demo/                      Golden demo orchestration

docs/
  GOLDEN_DEMO.md
  POLICY_CONFIG.md
  ARCHITECTURE.md

tests/
  cli/
  diagnostics/
  documentation/
  integration/
  planning/
  repository/
```

## Documentation

| Document | Purpose |
| --- | --- |
| [docs/GOLDEN_DEMO.md](./docs/GOLDEN_DEMO.md) | Canonical end-to-end walkthrough |
| [docs/POLICY_CONFIG.md](./docs/POLICY_CONFIG.md) | Current policy contract and example file |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Engine architecture plus generated repository snapshots |
| [ROADMAP.md](./ROADMAP.md) | Contributor-facing phase roadmap |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contribution workflow and expectations |

## Development Workflow

For local validation, the main commands are:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm ci:policy
```

SpecForge is deliberately strict about:

- deterministic behavior
- narrow, reviewable diffs
- tests alongside behavior changes
- documentation staying aligned with reality

## Roadmap

The current phase view lives in [ROADMAP.md](./ROADMAP.md).
For active prioritization, use it together with:

- [Development Tracker #54](https://github.com/iKwesi/SpecForge/issues/54)
- [SpecForge Development Project](https://github.com/users/iKwesi/projects/1)

## Contributing

If you want to contribute, start with [CONTRIBUTING.md](./CONTRIBUTING.md).

Short version:

- pick a scoped issue
- comment first so work does not overlap
- keep changes narrow and test-backed
- run local validation before opening a PR
- use `Squash and merge` or `Rebase and merge` on protected `main`

## License

Licensed under **Apache-2.0**. See [LICENSE](./LICENSE).
