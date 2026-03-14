# Policy Configuration

SpecForge validates policy files against the current v1 policy contract before using them as evidence.

Canonical example:
- [`docs/examples/specforge.policy.example.json`](./examples/specforge.policy.example.json)

## Coverage Policy

Controls how changed-line coverage is evaluated.

- `coverage.scope`
  - current supported value: `"changed-lines"`
- `coverage.enforcement`
  - `"report-only"` keeps CI informational
  - `"hard-block"` fails CI when changed-line coverage falls below the policy result

## Parallelism Policy

Controls the conservative scheduler.

- `parallelism.max_concurrent_tasks`
  - positive integer
  - v1 default: `2`
- `parallelism.serialize_on_uncertainty`
  - boolean
  - when `true`, SpecForge serializes tasks when touch-set or contract confidence is uncertain

## Gate Policy

Controls which approval gates are enabled by default and which project modes they apply to.

- `gates.enabled_by_default`
  - keyed by:
    - `proposal_approval`
    - `spec_approval`
    - `execution_start`
    - `merge_approval`
- `gates.applicable_project_modes`
  - arrays may contain only:
    - `greenfield`
    - `existing-repo`
    - `contribution`
    - `feature-proposal`

## Validation Behavior

When a policy file is invalid, SpecForge rejects it with path-specific errors such as:

- `coverage.enforcement must be "report-only" or "hard-block".`
- `parallelism.max_concurrent_tasks must be a positive integer.`
- `gates.applicable_project_modes.spec_approval[1] must be one of greenfield, existing-repo, contribution, feature-proposal.`
