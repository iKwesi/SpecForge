You are acting as a Staff+ software engineer implementing a production-grade developer platform tool.

The tool is named **SpecForge**.

SpecForge is a specification-driven engineering orchestration CLI that converts ideas and repository changes into disciplined, artifact-driven development workflows.

The system must meet engineering standards expected from organizations such as OpenAI, Anthropic, Stripe, or Google.

The implementation must prioritize correctness, determinism, maintainability, operational clarity, trust, and narrow v1 execution.

## Table of Contents

- [0. V1 PRODUCT INTENT](#0-v1-product-intent)
- [1. ENGINEERING STANDARDS](#1-engineering-standards)
- [2. REQUIRED V1 SCOPE](#2-required-v1-scope)
- [3. PROJECT MODES](#3-project-modes)
- [4. FEATURE-PROPOSAL BEHAVIOR](#4-feature-proposal-behavior)
- [5. OPEN SOURCE CONTRIBUTION MODE](#5-open-source-contribution-mode)
- [6. GLOSSARY](#6-glossary)
- [7. TECH STACK](#7-tech-stack)
- [8. ARCHITECTURE](#8-architecture)
- [9. REPOSITORY STRUCTURE](#9-repository-structure)
- [10. ARTIFACT VERSIONING CONTRACT](#10-artifact-versioning-contract)
- [10A. CONFIG / POLICY SOURCE OF TRUTH](#10a-config-policy-source-of-truth)
- [11. IDEA INTERROGATION MODEL](#11-idea-interrogation-model)
- [12. CONTEXT RETRIEVAL CONTRACT](#12-context-retrieval-contract)
- [13. SPEC GENERATION](#13-spec-generation)
- [14. ARCHITECTURE DIAGRAMS](#14-architecture-diagrams)
- [15. PARALLEL SAFETY MODEL](#15-parallel-safety-model)
- [16. WORKTREE / WORKSPACE EXECUTION MODEL](#16-worktree-workspace-execution-model)
- [17. GIT POLICY](#17-git-policy)
- [18. BRANCHING POLICY](#18-branching-policy)
- [19. README POLICY](#19-readme-policy)
- [20. ISSUE TRACKER INTEGRATION](#20-issue-tracker-integration)
- [21. SKILL CONTRACTS](#21-skill-contracts)
- [21A. ARTIFACT OWNERSHIP RULES](#21a-artifact-ownership-rules)
- [22. FRESH-CONTEXT EXECUTION POLICY](#22-fresh-context-execution-policy)
- [23. RALPH LOOP DEFINITION](#23-ralph-loop-definition)
- [24. CRITIC DEFINITION](#24-critic-definition)
- [25. GATE MODEL](#25-gate-model)
- [26. TDD EXECUTION](#26-tdd-execution)
- [27. CI POLICY](#27-ci-policy)
- [28. EXISTING REPOSITORY SUPPORT](#28-existing-repository-support)
- [29. MINIMAL DIFF POLICY](#29-minimal-diff-policy)
- [30. COMMIT MESSAGE STANDARD](#30-commit-message-standard)
- [31. GOLDEN DEMO REPO REQUIREMENT](#31-golden-demo-repo-requirement)
- [32. CLI UX REQUIREMENTS](#32-cli-ux-requirements)
- [33. DOCTOR COMMAND](#33-doctor-command)
- [34. EXPLAIN COMMAND](#34-explain-command)
- [35. DRY-RUN MODE](#35-dry-run-mode)
- [36. INSPECT COMMAND](#36-inspect-command)
- [37. V1 IMPLEMENTATION PHASES](#37-v1-implementation-phases)
- [38. POST-V1 NEXT PHASES](#38-post-v1-next-phases)
- [39. FUTURE COMMANDS / ROADMAP](#39-future-commands-roadmap)
- [40. FUTURE IMPROVEMENTS / PLATFORM ROADMAP](#40-future-improvements-platform-roadmap)
- [41. CLI COMMANDS](#41-cli-commands)
- [42. IMPLEMENTATION INSTRUCTIONS](#42-implementation-instructions)

## 0. V1 PRODUCT INTENT


SpecForge v1 is a CLI-first, local-first engineering orchestration tool.

Its v1 purpose is to:

1. turn an idea or change request into a structured engineering plan
2. generate a contract-first Spec Pack
3. decompose work into atomic tasks with safe dependency rules
4. build minimal context packs for stateless agent execution
5. execute a single task or a small set of safe parallel tasks via TDD
6. support existing repos, user repos, and OSS contribution workflows
7. generate basic architecture understanding artifacts
8. keep logs and artifacts reproducible
9. expose transparent, trustworthy CLI behavior for humans

SpecForge v1 is NOT required to fully implement every future platform capability.
It must instead establish the architecture and contracts needed to support them cleanly.

## 1. ENGINEERING STANDARDS


All code must follow professional software engineering practices.

Principles:
- KISS
- DRY
- SOLID
- 12-Factor App principles where applicable

Requirements:
- explicit typed interfaces
- clear separation of concerns
- small cohesive modules
- minimal hidden state
- deterministic behavior where possible
- idempotent operations where possible
- structured logging
- strong error handling
- testability by design
- boring, maintainable engineering over cleverness
- outputs that are trustworthy, human-readable, and grounded in real system state

Avoid:
- God objects
- prompt spaghetti
- hidden global state
- framework lock-in
- unnecessary abstraction
- oversized v1 scope
- invented execution state
- opaque agent behavior

## 2. REQUIRED V1 SCOPE


The following are REQUIRED in v1:

- project mode handling
- idea interrogation
- PRD generation
- Spec Pack generation
- artifact indexing
- work graph generation
- atomic task enforcement
- context pack construction
- single-task TDD execution
- safe limited parallel scheduling
- GitHub PR integration
- CI status/reporting
- README management for owned repos
- existing repo profiling
- contribution-safe mode
- native git fallback
- deterministic logs and artifact versioning
- sf alias support
- sf doctor
- sf explain
- sf inspect
- dry-run support

V1 parallel execution must be intentionally conservative.

V1 limits:
- default maximum concurrent task executions: 2
- parallel execution is allowed only for tasks with high-confidence touch_set classification
- if touch_set, contract impact, or shared asset impact is uncertain, the scheduler must serialize execution
- documentation-only or analysis-only tasks may be parallelized more easily than code-mutating tasks, subject to the same safety checks

The following are OPTIONAL for later phases and do not need full v1 implementation:

- issue trackers beyond one initial provider
- advanced notifier integrations
- full evaluation harness execution
- distributed runner
- replayable run command
- contract drift detection
- decision search/query tooling
- advanced diagram generation
- future analysis/planning/upgrade/spec extraction commands
- risk metric execution and hotspot scoring
- domain packs

## 3. PROJECT MODES


SpecForge must support four project modes:

1. greenfield
   - new project owned by the user

2. existing-repo
   - existing repository owned by the user/team

3. contribution
   - contributing to an external/open-source repository

4. feature-proposal
   - proposing a new feature or improvement not yet tracked as an issue

If project mode is not specified, the CLI must prompt for it.

## 4. FEATURE-PROPOSAL BEHAVIOR


Feature proposals behave differently depending on repository ownership.

For user-owned repositories:

1. generate proposal brief
2. get user approval
3. generate delta artifacts required for the requested change
4. generate tasks
5. execute using the approved internal workflow:
   - delta spec
   - updated DAG
   - atomic tasks
   - TDD execution
   - PR/CI workflow

For external/open-source repositories:

1. generate proposal brief
2. optionally generate issue or discussion draft
3. wait for maintainer approval
4. after approval, switch to contribution mode
5. do not implement code before approval exists

The implementation must not use vague phrases like “implement normally.”
It must explicitly transition to the correct workflow.

## 5. OPEN SOURCE CONTRIBUTION MODE


When project_mode = contribution:

- do not modify repository structure
- do not create new top-level directories
- store all SpecForge artifacts under `.specforge/`
- use feature branches only
- never push directly to upstream default branch
- open PRs from fork
- respect repository formatting, linting, CI, and contribution norms
- keep diffs minimal
- only modify docs when required by the change

## 6. GLOSSARY


Spec Pack
- the structured engineering artifact set produced by SpecForge
- includes specification, contracts, acceptance criteria, decisions, and work graph

Contract
- a formally defined interface boundary used by the system
- examples:
  - API schema
  - type definition
  - persistence schema
  - CLI interface
  - config schema
  - protocol definition

touch_set
- normalized set of files, modules, or resources expected to be modified by a task

Context Pack
- minimal execution payload constructed for one agent/subagent invocation
- must contain only the relevant excerpts and constraints for that run

Atomic Task
- smallest independently executable work unit in the DAG
- must be bounded, testable, and safe to reason about in isolation

Ralph Loop
- bounded generate/validate/repair loop used only during code execution
- max iterations must be enforced
- every iteration uses fresh context

Critic
- validation stage run after implementation attempts
- checks correctness, policy adherence, and execution readiness

Gate
- explicit approval checkpoint before pipeline continuation

Delta Spec
- specification artifact describing only the requested change relative to an existing system

Replayable Run
- recorded execution trace sufficient to reconstruct or replay a prior run

Repo Profile
- structured artifact summarizing an existing repository’s stack, layout, tooling, and likely boundaries

Architecture Summary
- structured explanation of the system or subsystem layout derived from repository inspection

Risk Metric
- a computed quality/change-risk signal derived from one or more sources such as complexity, coverage, churn, or dependency criticality

Hotspot
- a file, module, or function identified as relatively risky to modify due to poor testability, high complexity, high churn, or other quality signals

## 7. TECH STACK


Primary language: TypeScript (Node.js)

TypeScript must be used for all core engine logic.

Python is not required for v1.
Python may be added later for specialized workloads such as:
- large evaluation analysis
- data-heavy processing
- ML experimentation

Vercel AI SDK may be used only inside model/backend adapters.

It must not leak into core engine contracts or business logic.

## 8. ARCHITECTURE


SpecForge must follow layered architecture.

Layer 1 — Core Engine
Responsibilities:
- pipeline state machine
- artifact manager
- versioning manager
- DAG scheduler
- atomicity enforcer
- context pack builder
- Ralph loop controller
- policy enforcement
- structured logging
- state explanation services

Layer 2 — Tool Adapters
External integrations must be behind interfaces:
- GitProvider
- RepoHostProvider
- IssueTrackerProvider
- DiagramProvider
- ModelProvider
- ShellProvider
- FileStore
- Notifier
- ComplexityProvider (future)
- CoverageProvider (future)
- RiskMetricProvider (future)

Layer 3 — Runner
Execution environment abstraction:
- LocalRunner
- ServiceRunner (future)

Business logic must not exist in Runner.

## 9. REPOSITORY STRUCTURE


/
  .specforge/
    config.json
    capabilities.json
    runs/<run_id>/
      logs.json
      artifacts.json
      review_ready.md
      approvals.json
      state.json
    repo_profile.json
    architecture_summary.md
  prd/
    PRD.md
    PRD.json
  spec/
    SPEC.md
    decisions.md
    dag.yaml
    index.json
  schemas/
    *.schema.json
  acceptance/
    *.md
  eval/
    plan.md
  diagrams/
    system_context.excalidraw
    containers.excalidraw
    workflow_dag.excalidraw
    system_context.svg
    containers.svg
    workflow_dag.svg
  tickets/
    plan.json
    issue_export.json
  src/
  docs/
    ARCHITECTURE.md
  .github/workflows/
    ci.yml
  README.md

In contribution mode, all generated internal artifacts must stay under `.specforge/` unless explicitly required otherwise.

For user-owned repositories, the default artifact layout may use the top-level structure shown above.
The architecture should allow future support for alternative artifact layouts through config, including `.specforge/`-only storage, without changing core engine contracts.

## 10. ARTIFACT VERSIONING CONTRACT


All generated artifacts must include metadata:

- artifact_id
- artifact_version
- parent_version (if applicable)
- created_timestamp
- generator
- source_refs
- checksum/hash

Artifacts are immutable once published for a run.
Updates create a new version.

Context packs and downstream artifacts must reference specific artifact versions.

If a source artifact changes, dependent derived artifacts must be invalidated or regenerated.

## 10A. CONFIG / POLICY SOURCE OF TRUTH


SpecForge behavior must be governed by explicit config/policy artifacts, not hidden defaults.

At minimum, config/policy must control:
- enabled gates
- parallelism limits
- coverage policy
- eval enablement
- contribution mode restrictions
- preferred providers/adapters
- dry-run behavior where relevant
- explain output verbosity
- risk thresholds for future quality analysis

Runtime behavior must be explainable from config/policy plus current artifacts.

## 11. IDEA INTERROGATION MODEL


SpecForge must use the 12-bucket interrogation model.

Buckets:
1. Outcome
2. Users / Roles
3. Non-goals
4. Inputs
5. Outputs
6. Workflow
7. Interfaces
8. Quality bar
9. Safety / Compliance
10. Failure modes
11. Evaluation
12. Operations

Rules:
- ask only about missing or ambiguous buckets
- maximum 10 questions per round
- stop when minimum required clarity is reached
- allow explicit user override to proceed with assumptions
- record unresolved assumptions if any remain

Stopping condition:
- all required buckets for the current mode are present
OR
- the user explicitly approves proceeding with documented assumptions

Output:
- idea_brief.json

## 12. CONTEXT RETRIEVAL CONTRACT


SpecForge must implement indexed, provenance-aware retrieval.

All source artifacts must be chunked by stable section identifiers.

Every excerpt included in a context pack must include provenance metadata:
- artifact_id
- artifact_version
- section_id
- byte/line/heading range

Context pack builder rules:
- prefer structural sections over semantic blob retrieval
- do not include full PRD or full SPEC unless explicitly required
- enforce max context thresholds
- include only the minimum required excerpts
- invalidate cached excerpts when source artifact versions change

A weak “search and stuff random snippets” implementation is not acceptable.

## 13. SPEC GENERATION


SpecForge must generate a contract-first Spec Pack including:

- PRD.md
- PRD.json
- SPEC.md
- schemas/*.schema.json
- acceptance/*.md
- decisions.md
- dag.yaml
- spec/index.json

Spec generation must avoid open-ended iterative self-repair in v1.

Rules:
- no Ralph loop is allowed in PRD/spec generation
- at most one deterministic normalization or repair pass is allowed after validation
- deterministic repair may fix structural issues such as missing references, malformed indexes, or naming inconsistencies
- deterministic repair must not silently change intended product or architecture meaning

## 14. ARCHITECTURE DIAGRAMS


SpecForge should support Excalidraw-based architecture diagrams.

Required design targets:
- System Context Diagram
- Container / Service Architecture Diagram
- Workflow DAG Diagram

Store as:
- .excalidraw
- .svg

For v1:
- diagram generation support is encouraged but may be implemented as optional or minimal if needed to keep v1 sharp
- the DiagramProvider interface must exist even if generation is initially basic

## 15. PARALLEL SAFETY MODEL


Tasks may run in parallel only if ALL are true:

- no dependency edge blocks execution
- touch_sets do not overlap
- writes_contracts do not overlap
- no running task mutates a contract another running task reads
- no task mutates shared mutable assets

Shared mutable assets include, at minimum:
- package manifests
- lockfiles
- generated code inputs
- CI configuration
- global configuration
- repo-wide formatter/linter configs

Any task touching shared mutable assets must be serialized.

If the scheduler cannot confidently determine touch_set boundaries, contract impact, or shared mutable asset impact, it must choose serialization over parallelism.

Safety must win over throughput in v1.

Post-merge rules:
- if a merged task changes a contract or shared mutable asset, affected sibling tasks must be revalidated
- scheduler must support invalidating or re-planning affected subgraphs

## 16. WORKTREE / WORKSPACE EXECUTION MODEL


Parallel tasks must run in isolated workspaces.

Preferred:
- GitButler workspace model

Required fallback:
- native git + worktrees

SpecForge must remain usable without GitButler.

Each task execution workspace must be isolated and cleaned after completion when safe.

## 17. GIT POLICY


Preferred Git provider:
- GitButler CLI

Required fallback:
- native git + worktrees

Git responsibilities:
- branch creation
- commit creation
- rebase/conflict handling
- workspace isolation

GitHub operations:
- gh CLI for PR creation
- gh CLI for CI status
- gh CLI for merge flows when applicable

GitButler must be preferred, not mandatory.

## 18. BRANCHING POLICY


Branch-based development is required.

Rules:
- main/default branch must remain stable
- each atomic task executes on its own branch or isolated workspace
- direct commits to main are disallowed unless explicitly overridden
- merge requires:
  - tests pass
  - CI passes
  - policy gates satisfied
  - eval gates if enabled

## 19. README POLICY


For greenfield, existing-repo, and feature-proposal in user-owned repos:

SpecForge must create and maintain README.md.

Requirements:
- preserve human-written content where possible
- update only the relevant sections
- avoid rewriting the entire README unnecessarily
- update setup/usage when commands or behavior change
- update architecture references when relevant
- link diagrams/docs when useful

In contribution mode:
- only change docs when required by the change
- keep docs diffs minimal

## 20. ISSUE TRACKER INTEGRATION


Issue tracking must be provider-based.

Interface:
- IssueTrackerProvider

Initial implementation may support one provider such as Linear.

Future providers may include:
- Jira
- GitHub Issues
- Azure DevOps

Core logic must remain provider-agnostic.

If provider-specific linking to GitHub is unavailable, SpecForge must support manual linking/comment updates through the provider adapter.

## 21. SKILL CONTRACTS


Each skill must be defined as a real contract, not just a label.

Every skill definition must include:
- name
- version
- purpose
- inputs schema
- outputs schema
- side effects
- invariants
- idempotency expectations
- failure modes / error codes
- observability fields

At minimum define the following skills:

skill.ideaInterview
Purpose:
- clarify idea into structured brief
Inputs:
- raw user idea
- project mode
Outputs:
- idea_brief.json
Side effects:
- writes artifact
Invariants:
- asks only needed questions
Failure modes:
- insufficient_input
- user_abort

skill.generatePRD
Purpose:
- generate structured PRD artifacts from an approved or accepted idea brief
Inputs:
- idea_brief
- project_mode
- unresolved_assumptions
Outputs:
- PRD.md
- PRD.json
Side effects:
- writes versioned PRD artifacts
Invariants:
- PRD must reflect the current idea brief and documented assumptions
- PRD must not invent major requirements unsupported by the idea brief
Failure modes:
- insufficient_idea_brief
- invalid_mode
- artifact_write_failed

skill.generateSpecPack
Purpose:
- generate contract-first engineering artifacts
Inputs:
- idea_brief
- PRD
Outputs:
- SPEC.md
- schemas
- acceptance
- decisions
- index
- initial dag

skill.validateSpecPack
Purpose:
- deterministic validation of required artifacts and references
Inputs:
- artifact set
Outputs:
- validation report
Invariants:
- no LLM loop
Failure modes:
- missing_required_section
- invalid_reference
- version_mismatch

skill.decomposeToWorkGraph
Purpose:
- convert spec artifacts into EPIC/STORY/TASK graph
Inputs:
- PRD
- SPEC
- schemas
- acceptance
Outputs:
- dag.yaml
Invariants:
- each task references acceptance + contract

skill.enforceAtomicity
Purpose:
- split oversized or unsafe tasks
Inputs:
- dag.yaml
Outputs:
- updated dag.yaml
Failure modes:
- unsplittable_task
- missing_dependency_info

skill.buildContextPack
Purpose:
- construct minimal fresh execution context
Inputs:
- task_id
- artifact index
- iteration_state
Outputs:
- context pack artifact
Invariants:
- no full-doc stuffing
- provenance metadata required
Failure modes:
- missing_artifact
- invalid_section_ref
- stale_artifact_version

skill.devTDDTask
Purpose:
- execute one atomic task with TDD and bounded repair loop
Inputs:
- task_id
- context_pack_ref
- repo_ref
- retry_policy
- branch_policy
Outputs:
- task execution result
- branch/PR refs if created
Invariants:
- red/green/refactor ordering
- max retries enforced
Failure modes:
- test_failure
- critic_failure
- merge_conflict
- policy_violation

skill.updateReadme
Purpose:
- update README.md for owned repositories while preserving human-authored value
Inputs:
- repo_state
- change_summary
- readme_path
- update_policy
Outputs:
- README diff/result
Side effects:
- modifies README.md
Invariants:
- do not rewrite unrelated sections
- preserve human-written content where possible
- preserve section structure and anchors where possible
- update only relevant setup/usage/architecture content
Failure modes:
- readme_not_found
- update_conflict
- policy_violation

skill.profileRepository
Purpose:
- inspect repository structure and produce a structured repo profile
Inputs:
- repo_root
- scan_policy
- ignore_rules
- project_mode
Outputs:
- repo_profile artifact
Side effects:
- writes repository profile artifact
Invariants:
- must avoid loading the full repository into model context
- must respect ignore rules and repository boundaries
Failure modes:
- repo_not_found
- unsupported_repo_state
- scan_failed

skill.mapArchitectureFromRepo
Purpose:
- generate architecture summary and optional diagrams from repository evidence
Inputs:
- repo_root
- repo_profile
- scan_policy
Outputs:
- architecture summary artifact
- optional diagram artifacts
Side effects:
- writes architecture artifacts
Invariants:
- architecture summary must be evidence-based
- uncertain conclusions must be marked as inferred
Failure modes:
- missing_repo_profile
- insufficient_evidence
- diagram_generation_failed

skill.generateDeltaSpec
Purpose:
- generate only change-specific artifacts relative to current repo/system state
Inputs:
- approved request/proposal
- existing artifacts
- repo profile
Outputs:
- delta spec artifacts
Invariants:
- delta generation must be scoped only to the approved change request
- unrelated system areas must not be re-specified unless required by dependency or contract impact
- baseline references must be explicit and versioned
Failure modes:
- unclear_baseline
- ambiguous_change_scope

skill.replanAffectedSubgraph
Purpose:
- regenerate only impacted graph portions after contract or task changes
Inputs:
- changed artifacts
- affected task set
Outputs:
- updated subgraph
- stale task list

skill.generateProposalBrief
Purpose:
- generate proposal artifact for feature-proposal mode
Inputs:
- user proposal
- repo ownership context
Outputs:
- proposal_summary.md
- optional issue/discussion draft
- scope
- non-goals
- rationale
- risks

## 21A. ARTIFACT OWNERSHIP RULES


To avoid overlapping responsibilities, each artifact class must have a single primary writer skill.

Primary ownership rules:

- idea_brief.json
  - primary writer: skill.ideaInterview

- PRD.md
- PRD.json
  - primary writer: skill.generatePRD

- SPEC.md
- schemas/*.schema.json
- acceptance/*.md
- decisions.md
- spec/index.json
  - primary writer: skill.generateSpecPack

- validation reports for spec artifacts
  - primary writer: skill.validateSpecPack

- dag.yaml
  - primary writer: skill.decomposeToWorkGraph

- updated dag.yaml for task splitting/refinement
  - primary writer: skill.enforceAtomicity

- context pack artifacts
  - primary writer: skill.buildContextPack

- repository profile artifacts
  - primary writer: skill.profileRepository

- architecture summary artifacts
- repo-derived architecture diagrams
  - primary writer: skill.mapArchitectureFromRepo

- delta-scoped spec artifacts
  - primary writer: skill.generateDeltaSpec

- proposal brief artifacts
  - primary writer: skill.generateProposalBrief

- README updates
  - primary writer: skill.updateReadme

- affected-subgraph replanning outputs
  - primary writer: skill.replanAffectedSubgraph

No other skill may rewrite an artifact owned by another skill except through an explicit regeneration workflow.
Cross-skill modifications must occur by producing a new artifact version through the owning skill’s contract.

## 22. FRESH-CONTEXT EXECUTION POLICY


Every agent invocation and every Ralph-loop iteration must start with fresh context.

Fresh context means:
- rebuild minimal context from artifacts
- include only relevant excerpts and constraints
- include previous failure summary if retrying
- do not carry forward prior conversations
- do not carry forward unrelated execution history

Agent execution must behave like stateless function calls over artifacts.

## 23. RALPH LOOP DEFINITION


Ralph Loop is the bounded generate/validate/repair loop used only during code execution.

Definition:
1. attempt implementation
2. run tests/checks
3. summarize failure
4. attempt bounded repair using fresh context
5. stop at configured retry limit

Rules:
- max retries default: 3
- each retry uses a rebuilt context pack
- prior failure summaries may be included
- no unbounded self-repair

Ralph Loop must not be used during:
- PRD generation
- spec generation
- ticket creation
- diagram generation

## 24. CRITIC DEFINITION


Critic is a validation stage executed after an implementation attempt.

Critic may include:
- test result assessment
- lint/typecheck outcome assessment
- contract compliance checks
- minimal diff policy checks
- branch/CI readiness checks

For v1, critic may be implemented in a simple deterministic way where possible.
Do not make critic an underdefined magical component.

Internally, critic should be implementable as a composed validation pipeline rather than a single opaque component.

For example, critic may be structured as:
- TestValidator
- PolicyValidator
- DiffValidator
- ReadinessValidator

## 25. GATE MODEL


SpecForge must support explicit named gates.

At minimum define:
- proposal_approval
- spec_approval
- execution_start
- merge_approval

Gate behavior must be policy-driven and mode-aware.

Rules:
- gates may be enabled or disabled by config/policy
- gate applicability must be explicit per project mode
- approvals must never depend on hidden behavior
- approvals are scoped to the current run and the specific artifact versions they approve
- if approved artifacts change version, the affected approval must be invalidated
- gate status must be visible via status/explain output

Examples:
- proposal_approval applies to feature-proposal mode
- spec_approval may apply before DAG/task execution begins
- execution_start may apply before code modification begins
- merge_approval applies before merge actions

CLI:
- specforge approve <gate>
- sf approve <gate>

## 26. TDD EXECUTION


Task execution must follow strict TDD order:

1. RED — write failing test reproducing desired behavior or bug
2. GREEN — minimal implementation to satisfy test
3. REFACTOR — improve structure without changing behavior
4. CRITIC — validate policy/correctness readiness
5. PR/CI — open PR/check CI where applicable

Do not skip RED except by explicit override.

## 27. CI POLICY


CI must support, at minimum:
- lint
- typecheck
- unit tests
- integration tests where applicable
- schema validation where applicable

Coverage policy must be explicit.

For v1, implement one concrete approach:
- changed-lines coverage check

Do not leave “coverage on changed code” undefined.

Evaluation gates:
- optional in v1
- if enabled, source of truth must come from config/policy
- if eval/plan.md exists and eval is enabled, regression blocks merge

## 28. EXISTING REPOSITORY SUPPORT


SpecForge must support existing repositories.

Required capabilities:
- language/framework detection
- CI/test framework detection
- module layout detection
- architecture summary generation
- delta spec generation for requested changes

This must work without scanning the entire repo into model context.

## 29. MINIMAL DIFF POLICY


Implementation must:
- modify the smallest set of files possible
- avoid unrelated refactoring
- avoid unnecessary renames/moves
- respect repository style and conventions

## 30. COMMIT MESSAGE STANDARD


Use conventional commits.

Examples:
- fix(parser): handle empty API response
- feat(cli): add context pack builder
- test(dag): add scheduler coverage

## 31. GOLDEN DEMO REPO REQUIREMENT


SpecForge v1 should ship with a tiny reference or demo project.

Purpose:
- make the workflow understandable in under 5 minutes
- demonstrate artifact generation, tasking, and execution

Example acceptable demo:
- small Todo API
- small CLI utility
- similarly bounded project

The demo should support:
- sf init
- sf start
- sf explain
- sf run-task

## 32. CLI UX REQUIREMENTS


SpecForge must expose both:

- specforge
- sf

sf is a short alias for specforge.

Both commands must execute the same CLI.

The CLI must include clear help output and command descriptions.

Add:
- sf doctor
- sf explain
- sf inspect

Dry-run must be supported where applicable.

User-facing output must be:
- concise
- grounded in real state
- readable by engineers
- explicit about why steps are blocked or serialized
- explicit about what changed, what was generated, and what remains

Avoid theatrical or overly anthropomorphic CLI behavior.

## 33. DOCTOR COMMAND


Command:
- specforge doctor
- sf doctor

Purpose:
- verify local environment and repo readiness

Checks may include:
- Node version
- Git availability
- gh availability/auth state
- GitButler availability
- config validity
- repo state sanity
- required permissions

Outputs:
- human-readable summary
- machine-readable status if useful

## 34. EXPLAIN COMMAND


Command:
- specforge explain
- sf explain

Purpose:
- show the current execution plan in human-readable form before or during execution

The output should summarize:
- project mode
- artifacts generated
- work graph overview
- atomic tasks
- dependency relationships
- parallel opportunities
- affected contracts
- shared mutable assets
- active gates
- next execution steps

This command is a trust-building and transparency feature.

Explain output must be derived from actual artifacts, config/policy, and scheduler state.
It must not invent plan steps that are not represented in the current run state.

## 35. DRY-RUN MODE


SpecForge must support dry-run behavior.

Purpose:
- show what would happen without modifying code or opening PRs

Examples:
- specforge start --mode autopilot --dry-run
- sf start --mode autopilot --dry-run

Dry-run output should include:
- artifacts that would be generated
- tasks that would be created
- branches/workspaces that would be created
- PRs/issues that would be opened
- which steps are blocked by gates

## 36. INSPECT COMMAND


Command:
- specforge inspect
- sf inspect
- optional: sf inspect --deep

Purpose:
- understand an existing repository quickly and generate a machine- and human-usable engineering map

Outputs should include:
- repo profile
- architecture summary
- detected frameworks/tools
- detected contracts/interfaces where possible
- likely entrypoints
- module or subsystem boundaries
- initial architecture diagrams where supported
- readiness summary for SpecForge planning

Artifacts may include:
- .specforge/repo_profile.json
- .specforge/architecture_summary.md
- diagrams/system_context.excalidraw

This command should feel highly useful immediately, even without adopting the entire workflow.

Inspect must be non-destructive by default.
It may generate internal analysis artifacts, but it must not modify application source code, dependency manifests, CI configuration, or README unless explicitly instructed.

## 37. V1 IMPLEMENTATION PHASES


Phase 1 — Core Contracts and Artifacts
Implement:
- glossary-backed types
- artifact versioning
- config/policy model
- skill interfaces
- ideaInterview
- generatePRD
- generateSpecPack
- validateSpecPack

Phase 2 — Planning and Context
Implement:
- decomposeToWorkGraph
- enforceAtomicity
- artifact indexing
- buildContextPack
- profileRepository
- generateDeltaSpec
- generateProposalBrief

Phase 3 — Execution
Implement:
- devTDDTask
- critic
- Ralph loop
- git provider abstraction
- GitButler preferred path
- native git fallback
- single-task branch workflow

Phase 4 — Safe Parallelism
Implement:
- scheduler
- workspace/worktree handling
- contract-safe concurrency checks
- replanAffectedSubgraph

Phase 5 — Integration and UX
Implement:
- GitHub/gh integration
- one issue tracker provider
- README updates
- status/reporting
- approve gates
- sf alias
- sf doctor
- sf explain
- dry-run
- sf inspect

Phase 6 — Hardening
Implement:
- CI integration
- changed-lines coverage policy
- docs
- example project
- contribution mode polish

## 38. POST-V1 NEXT PHASES


After v1 is working, implement optional items in this order:

Phase 7 — Optional Integrations
- additional issue tracker providers
- notifier integrations
- richer diagram generation

Phase 8 — Evaluation
- optional eval harness execution
- configurable eval gates
- domain-specific eval adapters

Phase 9 — Service Mode Foundations
- ServiceRunner implementation
- remote job execution
- shared state backend
- multi-repo orchestration

Phase 10 — Risk Analysis
- ComplexityProvider implementation
- CoverageProvider integration beyond basic CI use
- RiskMetricProvider implementation
- hotspot scoring for files/functions/modules
- risk-aware inspect/analyze output
- risk-aware task planning and gating

Phase 11 — Replay and Drift
- replayable run execution/review
- contract drift detection
- stale artifact diagnosis
- reasoning/decision query support

Phase 12 — Domain Packs
- webapp
- data-engineering
- ai-agents
- ml-platform

## 39. FUTURE COMMANDS / ROADMAP


These commands do not need full v1 implementation, but the architecture should make them easy to add.

A. sf analyze
Purpose:
- perform deeper repository and code-quality analysis than sf inspect
Potential outputs:
- coupling hotspots
- missing tests
- policy violations
- complexity warnings
- contract risk areas
- CRAP-style change-risk signals derived from complexity and coverage

B. sf plan
Purpose:
- generate a structured improvement or implementation roadmap from current repo state or proposal
Potential outputs:
- prioritized stories/tasks
- phased execution plan
- risk summary
- dependency map

C. sf upgrade
Purpose:
- propose or execute modernization work for a codebase
Potential targets:
- dependency upgrades
- architecture cleanup
- test hardening
- CI modernization
- contract extraction for legacy systems

D. sf spec
Purpose:
- derive or regenerate formal specification artifacts from an existing repository
Potential outputs:
- extracted contracts
- acceptance scaffolds
- delta specs for subsystems

These future commands should build on:
- profileRepository
- mapArchitectureFromRepo
- generateDeltaSpec
- decomposeToWorkGraph
- buildContextPack

## 40. FUTURE IMPROVEMENTS / PLATFORM ROADMAP


These are important future capabilities and should be architecturally supported now, but not fully implemented in v1.

A. Replayable Engineering Runs
Purpose:
- reproduce and audit prior runs
Capture:
- idea brief
- PRD version
- spec version
- DAG version
- context packs
- commands executed
- CI results
- commits/PRs

B. Contract Drift Detection
Purpose:
- detect mismatches between spec, schemas, acceptance, and code
Examples:
- schema changed but downstream tasks stale
- spec updated but code not aligned
- acceptance violated by later edits

C. Decision Ledger
Purpose:
- preserve architectural reasoning
Record:
- decision summary
- rationale
- alternatives considered
- affected artifacts
Storage:
- spec/decisions.md
Future:
- query/search support

D. Domain Packs
Potential future packs:
- webapp
- data-engineering
- ai-agents
- ml-platform

E. Risk-Aware Engineering
Purpose:
- detect and manage risky change zones before execution
Sources may include:
- complexity
- coverage
- churn
- dependency criticality

Examples:
- warn when a task touches high-risk, low-covered code
- require stricter TDD or approvals for high-risk changes
- suggest refactors or test hardening in hotspots

## 41. CLI COMMANDS


Primary commands:
- specforge init
- specforge start --mode manual
- specforge start --mode autopilot
- specforge run-task <task_id>
- specforge status
- specforge approve <gate>
- specforge doctor
- specforge explain
- specforge inspect

Alias commands:
- sf init
- sf start --mode manual
- sf start --mode autopilot
- sf run-task <task_id>
- sf status
- sf approve <gate>
- sf doctor
- sf explain
- sf inspect

## 42. IMPLEMENTATION INSTRUCTIONS


Build SpecForge according to this specification.

Requirements:
- keep v1 narrow and solid
- implement required v1 scope first
- do not overbuild optional features into v1
- use explicit types and contracts
- make the code reviewable by senior engineers
- provide a clear README
- provide example workflow usage
- provide file tree and setup instructions
- ensure the CLI UX feels practical for real developers
- preserve trust through deterministic artifacts, truthful explain output, and non-destructive inspection defaults
