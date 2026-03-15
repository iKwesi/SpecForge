# SpecForge Roadmap

This roadmap is the contributor-facing view of where SpecForge is headed next.
It is intentionally lighter than the master specification: the goal is to make
issue priority and phase intent easy to scan before someone picks up work.

## Principles

- Keep the engine deterministic, explainable, and test-first.
- Prefer narrow, composable slices over large speculative rewrites.
- Treat policy, trust, and approval boundaries as first-class product behavior.
- Keep core operations separate from external skill/provider integration.

## Phase Summary

### v1 Foundations

Core artifact, planning, execution, diagnostics, GitHub integration, CI, and
brownfield inspection foundations are in place.

Recently completed milestones:

- `#41` architecture docs generation from inspect/profile artifacts
- `#59` skill registry
- `#60` skill selection policy

Outcome:

- SpecForge can move from repository understanding to deterministic planning,
  execution control, diagnostics, and explainable status reporting with working
  CI guardrails.

### v1.1 Near-Term

These issues tighten adoption, contributor clarity, and the first usable skill
runtime defaults.

| Issue | Focus | Phase outcome |
| --- | --- | --- |
| [#61](https://github.com/iKwesi/SpecForge/issues/61) | Built-in skill bootstrap | Default skill catalog works even without external providers |
| [#70](https://github.com/iKwesi/SpecForge/issues/70) | High-signal comment backfill | Core invariants become easier for contributors to read safely |
| [#45](https://github.com/iKwesi/SpecForge/issues/45) | Roadmap publication | Contributors can map issues to phase intent without reading the full spec |
| [#54](https://github.com/iKwesi/SpecForge/issues/54) | Development tracker | Phase tracking stays visible across v1, v1.1, and future work |

Outcome:

- New contributors can understand current priorities faster, and the skill layer
  becomes usable by default instead of only when external providers are wired.

### Future Expansion

These issues extend SpecForge beyond the current v1/v1.1 engine into broader
provider support, observability, architecture tooling, and remote execution.

| Issue | Focus | Phase outcome |
| --- | --- | --- |
| [#53](https://github.com/iKwesi/SpecForge/issues/53) | External skill packs and provider adapters | Skill ecosystem expands beyond built-in defaults |
| [#52](https://github.com/iKwesi/SpecForge/issues/52) | Replayable run and contract drift diagnostics | Runs become easier to audit, replay, and compare over time |
| [#51](https://github.com/iKwesi/SpecForge/issues/51) | Risk analysis providers and hotspot scoring | Planning gains risk-aware prioritization signals |
| [#50](https://github.com/iKwesi/SpecForge/issues/50) | Service-mode foundations | Remote execution becomes possible without collapsing core boundaries |
| [#49](https://github.com/iKwesi/SpecForge/issues/49) | Evaluation harness and eval gates | Quality checks expand beyond unit/integration signals |
| [#48](https://github.com/iKwesi/SpecForge/issues/48) | Richer architecture diagram pipeline | Inspect output becomes more useful for technical communication |
| [#47](https://github.com/iKwesi/SpecForge/issues/47) | Notifier integrations | Run and PR state can reach users outside the CLI |
| [#46](https://github.com/iKwesi/SpecForge/issues/46) | Additional issue tracker providers | Workflow support expands beyond GitHub |

Outcome:

- SpecForge evolves from a strong local deterministic engine into a broader
  orchestration platform with richer provider support, observability, and
  ecosystem integration.

## How To Use This Roadmap

- Start with the project board: <https://github.com/users/iKwesi/projects/1>
- Cross-check phase intent with the development tracker: <https://github.com/iKwesi/SpecForge/issues/54>
- Pick issues that match the current phase unless a maintainer explicitly
  redirects work

When priorities shift, update this file and the linked tracker together so the
roadmap stays trustworthy.
