# SpecForge Architecture

SpecForge is a deterministic orchestration engine that coordinates artifact-driven engineering workflows.

## 1. Core Engine

Responsibilities:
- run-state orchestration
- artifact/version management
- policy and gate enforcement
- deterministic planning and execution control

Core runtime logic is implemented as **operations** (internal deterministic units), not external skills.

## 2. Skill Registry

Responsibilities:
- discover installed skills
- track provider metadata and trust/verification status
- expose skill capability contracts (supported domains/task types, input/output shape)
- support selection policy hooks for recommendation and approval

The registry is provider-agnostic and supports local, internal, and trusted external sources.

## 3. External Skills

External skills are reusable capability plugins that provide domain expertise.

Skill source categories:
- built-in defaults
- verified provider/marketplace skills
- user-installed custom skills

SpecForge orchestrates when and how skills are used; skills do not replace engine policy or safety controls.

## 4. Execution Agents

Execution agents run selected operations and skill-backed tasks under engine policy.

Responsibilities:
- execute task payloads with provided context packs
- report structured outputs/errors
- remain bounded by policy, approvals, and deterministic artifact contracts

The engine remains the source of truth for workflow state, gates, and artifact provenance.
