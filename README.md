# SpecForge

[![CI](https://github.com/iKwesi/SpecForge/actions/workflows/ci.yml/badge.svg)](https://github.com/iKwesi/SpecForge/actions/workflows/ci.yml)

SpecForge is a specification-driven engineering orchestration CLI that converts ideas and repository changes into disciplined, artifact-driven development workflows.

SpecForge treats software engineering like a deterministic build system: ideas become specs, specs become tasks, and tasks become tested, reviewable changes.

| [Contributing](./CONTRIBUTING.md) | [Roadmap](./ROADMAP.md) | [License](./LICENSE) | [Development Tracker](https://github.com/iKwesi/SpecForge/issues/54) | [Project Board](https://github.com/users/iKwesi/projects/1) |
| --- | --- | --- | --- | --- |

## Status

Early development. The repository is currently implementing Phase 1 foundations:
- core contracts
- artifact versioning
- policy/config model
- test and build scaffold

## Internal Operations vs External Skills

SpecForge separates deterministic orchestration logic from reusable capability plugins:

- Internal operations:
  - deterministic workflow units in the core engine
  - responsible for artifact generation, validation, planning, decomposition, scheduling, and execution control
  - implemented under `src/core/operations`

- External skills:
  - reusable domain-specific capability plugins (built-in, verified provider, or user-installed)
  - discovered and managed through a Skill Registry / provider layer
  - selected by policy based on task type, trust, and compatibility

SpecForge orchestrates workflow and safety; skills provide domain expertise.
It is a structured engineering orchestration layer, not a monolithic domain-expert agent.

## Tech Stack

- TypeScript
- Node.js
- pnpm
- Vitest
- Commander

## Getting Started

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## Golden Demo

Run `pnpm demo:golden` to execute the canonical existing-repo walkthrough and generate a regression manifest. The full workflow and outputs are documented in [docs/GOLDEN_DEMO.md](./docs/GOLDEN_DEMO.md).

## Policy Configuration

Policy contract details and the canonical example file are documented in [docs/POLICY_CONFIG.md](./docs/POLICY_CONFIG.md).

## Roadmap

The contributor-facing phase roadmap lives in [ROADMAP.md](./ROADMAP.md). Use it with the
[Development Tracker](https://github.com/iKwesi/SpecForge/issues/54) and the
[Project Board](https://github.com/users/iKwesi/projects/1) when choosing the next issue.

## Contributing

- Contributor guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Development Tracker issue: <https://github.com/iKwesi/SpecForge/issues/54>
- GitHub Project board: <https://github.com/users/iKwesi/projects/1>

## License

Licensed under **Apache-2.0**. See [LICENSE](./LICENSE).
