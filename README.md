# SpecForge

SpecForge is a specification-driven engineering orchestration CLI that converts ideas and repository changes into disciplined, artifact-driven development workflows.

SpecForge treats software engineering like a deterministic build system: ideas become specs, specs become tasks, and tasks become tested, reviewable changes.

## Status

Early development. The repository is currently implementing Phase 1 foundations:
- core contracts
- artifact versioning
- policy/config model
- test and build scaffold

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

## Contributing

- Contributor guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Development Tracker issue: <https://github.com/iKwesi/SpecForge/issues/54>
- GitHub Project board: <https://github.com/users/iKwesi/projects/1>

## License

Licensed under **Apache-2.0**. See [LICENSE](./LICENSE).
