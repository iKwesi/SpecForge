# Golden Demo

The golden demo is the canonical end-to-end SpecForge walkthrough for an existing repository.
It gives us one repeatable scenario that proves the value stream from repository inspection to task execution artifacts.

## Run It

```bash
pnpm install
pnpm demo:golden
```

To write the demo workspace somewhere specific:

```bash
pnpm demo:golden -- --workspace-root ./tmp/specforge-golden-demo
```

For safety, custom workspace roots must stay under `./tmp`, `./.tmp`, or your OS temp directory. The demo resets that workspace before it copies the fixture repository.

## What It Does

The demo copies a small existing-repo fixture into an isolated workspace, initializes it as a git repository, and then runs the following workflow:

1. `sf doctor` validates local runtime, git, pnpm, repository readiness, and policy shape.
2. `sf inspect` profiles the fixture repository and writes bounded architecture artifacts.
3. The artifact chain runs in-process for deterministic regression coverage:
   - `ideaInterview`
   - `generatePRD`
   - `generateSpecPack`
   - `decomposeToWorkGraph`
   - `buildContextPack`
   - `devTDDTask`
   - `criticRalphLoop`
4. `sf explain` renders artifact lineage for the generated task execution result.
5. `sf status` prints simulated GitHub status output so the demo stays runnable without a live pull request.

## Outputs

The demo writes these key files into the chosen workspace:

- `repository/` — a copied fixture repository used for brownfield inspection
- `artifacts/.specforge/repo_profile.json`
- `artifacts/.specforge/architecture_summary.json`
- `artifacts/idea_brief.json`
- `artifacts/PRD.md`
- `artifacts/PRD.json`
- `artifacts/SPEC.md`
- `artifacts/spec/index.json`
- `artifacts/.specforge/context-packs/TASK-1.json`
- `artifacts/.specforge/task-results/TASK-1.json`
- `artifacts/.specforge/critic-results/TASK-1.json`
- `golden-demo-manifest.json`

`golden-demo-manifest.json` is the regression baseline. It captures command outputs plus the artifact ids, versions, and paths that the workflow produced.

## Why It Exists

This demo gives new contributors a concrete, runnable example of how SpecForge behaves today without assuming orchestration we have not built yet. It also gives the core team a stable end-to-end baseline that can be exercised in tests as the CLI grows.
