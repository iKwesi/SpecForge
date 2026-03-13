import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMetadata, ArtifactSourceRef, ArtifactVersion } from "../artifacts/types.js";
import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata
} from "../artifacts/versioning.js";
import type { ProjectMode } from "../contracts/domain.js";
import type { OperationContract } from "../contracts/operation.js";
import type { ArchitectureSummaryArtifact, ArchitectureSubsystem } from "./mapArchitectureFromRepo.js";
import type { ProposalSummaryArtifact } from "./generateProposalBrief.js";
import type { RepoProfileArtifact } from "./profileRepository.js";

const DELTA_SPEC_FILENAME = "delta_spec.json";
const PROPOSAL_SUMMARY_ALLOWED_STATUSES = ["approved", "accepted"] as const;

export type DeltaSpecProjectMode = Extract<ProjectMode, "existing-repo" | "feature-proposal">;

type ProposalSummaryAllowedStatus = (typeof PROPOSAL_SUMMARY_ALLOWED_STATUSES)[number];

export type GenerateDeltaSpecErrorCode =
  | "invalid_mode"
  | "insufficient_repo_profile"
  | "insufficient_architecture_summary"
  | "insufficient_proposal_summary"
  | "baseline_mismatch"
  | "invalid_scope"
  | "artifact_write_failed";

export class GenerateDeltaSpecError extends Error {
  readonly code: GenerateDeltaSpecErrorCode;
  readonly details?: unknown;

  constructor(code: GenerateDeltaSpecErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "GenerateDeltaSpecError";
    this.code = code;
    this.details = details;
  }
}

export interface GenerateDeltaSpecInput {
  project_mode: ProjectMode;
  change_summary: string;
  approved_scope: string[];
  repo_profile?: RepoProfileArtifact;
  architecture_summary?: ArchitectureSummaryArtifact;
  proposal_summary?: ProposalSummaryArtifact;
  proposal_summary_status?: string;
  artifact_dir?: string;
  created_timestamp?: Date;
}

export interface DeltaSpecImpact {
  subsystem_id: string;
  label: string;
  inferred_responsibility: string;
  evidence_refs: string[];
  matched_scope_entries: string[];
}

export interface DeltaSpecArtifact {
  kind: "delta_spec";
  metadata: ArtifactMetadata;
  project_mode: DeltaSpecProjectMode;
  repository_root: string;
  baseline_refs: ArtifactSourceRef[];
  change_summary: string;
  approved_scope: string[];
  impacted_subsystems: DeltaSpecImpact[];
  excluded_subsystems: string[];
  summary_markdown: string;
}

export interface GenerateDeltaSpecResult {
  delta_spec: DeltaSpecArtifact;
}

export const GENERATE_DELTA_SPEC_OPERATION_CONTRACT: OperationContract<
  GenerateDeltaSpecInput,
  GenerateDeltaSpecResult
> = {
  name: "operation.generateDeltaSpec",
  version: "v1",
  purpose: "Generate deterministic change-scoped delta specs from explicit approved scope.",
  inputs_schema: {} as GenerateDeltaSpecInput,
  outputs_schema: {} as GenerateDeltaSpecResult,
  side_effects: ["writes .specforge/delta_spec.json"],
  invariants: [
    "Delta spec baselines always reference exact source artifact versions.",
    "Only explicitly approved scope is included in impacted_subsystems.",
    "Feature-proposal mode requires proposal approval context in addition to repo baselines."
  ],
  idempotency_expectations: [
    "Equivalent baseline artifacts and approved scope produce stable impacted subsystem ordering."
  ],
  failure_modes: [
    "invalid_mode",
    "insufficient_repo_profile",
    "insufficient_architecture_summary",
    "insufficient_proposal_summary",
    "baseline_mismatch",
    "invalid_scope",
    "artifact_write_failed"
  ],
  observability_fields: [
    "project_mode",
    "repository_root",
    "approved_scope_count",
    "impacted_subsystem_count",
    "delta_spec_version"
  ]
};

/**
 * Builds a bounded delta spec from repository baselines plus explicit approved scope.
 *
 * In feature-proposal mode, the proposal summary is treated as an approval baseline for
 * the requested change, while repo_profile and architecture_summary still describe the
 * target repository. The operation never expands scope beyond the approved entries.
 */
export async function runGenerateDeltaSpec(
  input: GenerateDeltaSpecInput
): Promise<GenerateDeltaSpecResult> {
  if (input.project_mode !== "existing-repo" && input.project_mode !== "feature-proposal") {
    throw new GenerateDeltaSpecError(
      "invalid_mode",
      "generateDeltaSpec only supports existing-repo and feature-proposal modes."
    );
  }

  const repoProfile = ensureRepoProfile(input.repo_profile);
  const architectureSummary = ensureArchitectureSummary(input.architecture_summary);
  ensureBaselineCompatibility(repoProfile, architectureSummary);

  const normalizedChangeSummary = normalizeText(input.change_summary);
  if (normalizedChangeSummary.length === 0) {
    throw new GenerateDeltaSpecError("invalid_scope", "change_summary must be non-empty.");
  }

  const proposalSummary =
    input.project_mode === "feature-proposal"
      ? ensureProposalSummary(input.proposal_summary, input.proposal_summary_status)
      : undefined;

  const approvedScope = normalizeApprovedScope(input.approved_scope);
  const impactedSubsystems = resolveImpactedSubsystems(architectureSummary.subsystems, approvedScope);
  const excludedSubsystems = architectureSummary.subsystems
    .map((subsystem) => subsystem.id)
    .filter((subsystemId) => !impactedSubsystems.some((entry) => entry.subsystem_id === subsystemId));

  const baselineRefs: ArtifactSourceRef[] = [
    {
      artifact_id: repoProfile.metadata.artifact_id,
      artifact_version: repoProfile.metadata.artifact_version
    },
    {
      artifact_id: architectureSummary.metadata.artifact_id,
      artifact_version: architectureSummary.metadata.artifact_version
    }
  ];

  if (proposalSummary) {
    baselineRefs.push({
      artifact_id: proposalSummary.metadata.artifact_id,
      artifact_version: proposalSummary.metadata.artifact_version
    });
  }

  const summaryMarkdown = renderDeltaSpecMarkdown({
    project_mode: input.project_mode,
    repository_root: repoProfile.repository_root,
    change_summary: normalizedChangeSummary,
    baseline_refs: baselineRefs,
    impacted_subsystems: impactedSubsystems,
    excluded_subsystems: excludedSubsystems
  });

  const previousVersion = input.artifact_dir
    ? await readExistingDeltaSpecVersion(
        resolveArtifactDirectory(repoProfile.repository_root, input.artifact_dir)
      )
    : undefined;

  const content = JSON.stringify({
    project_mode: input.project_mode,
    repository_root: repoProfile.repository_root,
    baseline_refs: baselineRefs,
    change_summary: normalizedChangeSummary,
    approved_scope: approvedScope,
    impacted_subsystems: impactedSubsystems,
    excluded_subsystems: excludedSubsystems,
    summary_markdown: summaryMarkdown
  });

  const metadata = createDeltaSpecMetadata({
    content,
    source_refs: baselineRefs,
    ...(previousVersion ? { previous_version: previousVersion } : {}),
    ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
  });

  const deltaSpec: DeltaSpecArtifact = {
    kind: "delta_spec",
    metadata,
    project_mode: input.project_mode,
    repository_root: repoProfile.repository_root,
    baseline_refs: baselineRefs,
    change_summary: normalizedChangeSummary,
    approved_scope: approvedScope,
    impacted_subsystems: impactedSubsystems,
    excluded_subsystems: excludedSubsystems,
    summary_markdown: summaryMarkdown
  };

  if (input.artifact_dir) {
    await writeDeltaSpecArtifact({
      artifact_dir: resolveArtifactDirectory(repoProfile.repository_root, input.artifact_dir),
      delta_spec: deltaSpec
    });
  }

  return {
    delta_spec: deltaSpec
  };
}

function ensureRepoProfile(repoProfile?: RepoProfileArtifact): RepoProfileArtifact {
  if (!repoProfile || repoProfile.kind !== "repo_profile") {
    throw new GenerateDeltaSpecError(
      "insufficient_repo_profile",
      "Missing or invalid repo_profile artifact."
    );
  }

  return repoProfile;
}

function ensureArchitectureSummary(
  architectureSummary?: ArchitectureSummaryArtifact
): ArchitectureSummaryArtifact {
  if (!architectureSummary || architectureSummary.kind !== "architecture_summary") {
    throw new GenerateDeltaSpecError(
      "insufficient_architecture_summary",
      "Missing or invalid architecture_summary artifact."
    );
  }

  return architectureSummary;
}

function ensureProposalSummary(
  proposalSummary: ProposalSummaryArtifact | undefined,
  status: string | undefined
): ProposalSummaryArtifact {
  if (!proposalSummary || proposalSummary.kind !== "proposal_summary_markdown") {
    throw new GenerateDeltaSpecError(
      "insufficient_proposal_summary",
      "feature-proposal mode requires a valid proposal_summary artifact."
    );
  }

  if (
    !status ||
    !PROPOSAL_SUMMARY_ALLOWED_STATUSES.includes(status as ProposalSummaryAllowedStatus)
  ) {
    throw new GenerateDeltaSpecError(
      "insufficient_proposal_summary",
      "proposal_summary must be approved or accepted before delta spec generation."
    );
  }

  return proposalSummary;
}

function ensureBaselineCompatibility(
  repoProfile: RepoProfileArtifact,
  architectureSummary: ArchitectureSummaryArtifact
): void {
  if (repoProfile.repository_root !== architectureSummary.repository_root) {
    throw new GenerateDeltaSpecError(
      "baseline_mismatch",
      "repo_profile and architecture_summary must reference the same repository root."
    );
  }
}

function normalizeApprovedScope(approvedScope: string[]): string[] {
  const normalized = approvedScope
    .map((entry) => normalizeText(entry))
    .filter((entry) => entry.length > 0);

  if (normalized.length === 0) {
    throw new GenerateDeltaSpecError("invalid_scope", "approved_scope must contain at least one entry.");
  }

  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function resolveImpactedSubsystems(
  subsystems: ArchitectureSubsystem[],
  approvedScope: string[]
): DeltaSpecImpact[] {
  const subsystemById = new Map(subsystems.map((subsystem) => [subsystem.id, subsystem] as const));
  const matchesBySubsystemId = new Map<string, Set<string>>();

  for (const scopeEntry of approvedScope) {
    const matchingSubsystems = findMatchingSubsystems(subsystems, subsystemById, scopeEntry);

    if (matchingSubsystems.length === 0) {
      throw new GenerateDeltaSpecError(
        "invalid_scope",
        `approved_scope entry does not match a known baseline area: ${scopeEntry}`
      );
    }

    for (const subsystem of matchingSubsystems) {
      const matches = matchesBySubsystemId.get(subsystem.id) ?? new Set<string>();
      matches.add(scopeEntry);
      matchesBySubsystemId.set(subsystem.id, matches);
    }
  }

  return [...matchesBySubsystemId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([subsystemId, matches]) => {
      const subsystem = subsystemById.get(subsystemId)!;
      return {
        subsystem_id: subsystem.id,
        label: subsystem.label,
        inferred_responsibility: subsystem.inferred_responsibility,
        evidence_refs: [...subsystem.evidence_refs],
        matched_scope_entries: [...matches].sort((left, right) => left.localeCompare(right))
      };
    });
}

function findMatchingSubsystems(
  subsystems: ArchitectureSubsystem[],
  subsystemById: Map<string, ArchitectureSubsystem>,
  scopeEntry: string
): ArchitectureSubsystem[] {
  const exactMatch = subsystemById.get(scopeEntry);
  if (exactMatch) {
    return [exactMatch];
  }

  return subsystems.filter((subsystem) => {
    return subsystem.evidence_refs.some((evidenceRef) => {
      return evidenceRef === scopeEntry || evidenceRef.startsWith(`${scopeEntry}/`);
    });
  });
}

interface RenderDeltaSpecMarkdownInput {
  project_mode: DeltaSpecProjectMode;
  repository_root: string;
  change_summary: string;
  baseline_refs: ArtifactSourceRef[];
  impacted_subsystems: DeltaSpecImpact[];
  excluded_subsystems: string[];
}

function renderDeltaSpecMarkdown(input: RenderDeltaSpecMarkdownInput): string {
  const lines: string[] = [
    "# Delta Spec",
    "",
    `Project Mode: ${input.project_mode}`,
    `Repository Root: ${input.repository_root}`,
    "",
    "## Change Summary",
    input.change_summary,
    "",
    "## Baselines",
    ...input.baseline_refs.map(
      (reference) => `- ${reference.artifact_id}@${reference.artifact_version}`
    ),
    "",
    "Only explicitly approved scope is included.",
    "",
    "## Impacted Baseline Areas"
  ];

  for (const impactedSubsystem of input.impacted_subsystems) {
    lines.push(`### ${impactedSubsystem.subsystem_id}`);
    lines.push(`Responsibility: ${impactedSubsystem.inferred_responsibility}`);
    lines.push(`Matched Scope: ${impactedSubsystem.matched_scope_entries.join(", ")}`);
    lines.push("Evidence:");
    for (const evidenceRef of impactedSubsystem.evidence_refs) {
      lines.push(`- ${evidenceRef}`);
    }
    lines.push("");
  }

  lines.push("## Excluded Baseline Areas");
  if (input.excluded_subsystems.length === 0) {
    lines.push("- None");
  } else {
    for (const subsystemId of input.excluded_subsystems) {
      lines.push(`- ${subsystemId}`);
    }
  }

  const proposalBaseline = input.baseline_refs.find((reference) => reference.artifact_id === "proposal_summary.md");
  if (proposalBaseline) {
    lines.push("");
    lines.push(`Proposal Baseline: ${proposalBaseline.artifact_id}@${proposalBaseline.artifact_version}`);
  }

  return lines.join("\n").trimEnd();
}

function resolveArtifactDirectory(repositoryRoot: string, artifactDir?: string): string {
  return artifactDir ?? repositoryRoot;
}

interface CreateDeltaSpecMetadataInput {
  content: string;
  source_refs: ArtifactSourceRef[];
  previous_version?: ArtifactVersion;
  created_timestamp?: Date;
}

function createDeltaSpecMetadata(input: CreateDeltaSpecMetadataInput): ArtifactMetadata {
  if (!input.previous_version) {
    return createInitialArtifactMetadata({
      artifactId: "delta_spec",
      generator: "operation.generateDeltaSpec",
      sourceRefs: input.source_refs,
      content: input.content,
      ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
    });
  }

  return createNextArtifactMetadata({
    previous: {
      artifact_id: "delta_spec",
      artifact_version: input.previous_version,
      created_timestamp: "1970-01-01T00:00:00.000Z",
      generator: "operation.generateDeltaSpec",
      source_refs: input.source_refs,
      checksum: "0".repeat(64)
    },
    generator: "operation.generateDeltaSpec",
    sourceRefs: input.source_refs,
    content: input.content,
    ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
  });
}

async function readExistingDeltaSpecVersion(artifactDir: string): Promise<ArtifactVersion | undefined> {
  try {
    const raw = await readFile(join(artifactDir, ".specforge", DELTA_SPEC_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<DeltaSpecArtifact>;
    const version = parsed.metadata?.artifact_version;

    if (typeof version === "string" && /^v\d+$/.test(version)) {
      return version as ArtifactVersion;
    }

    throw new GenerateDeltaSpecError(
      "artifact_write_failed",
      "Existing delta_spec has invalid metadata.artifact_version."
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof GenerateDeltaSpecError) {
      throw error;
    }

    throw new GenerateDeltaSpecError(
      "artifact_write_failed",
      "Failed to inspect existing delta_spec artifact.",
      error
    );
  }
}

async function writeDeltaSpecArtifact(input: {
  artifact_dir: string;
  delta_spec: DeltaSpecArtifact;
}): Promise<void> {
  try {
    const outputDir = join(input.artifact_dir, ".specforge");
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, DELTA_SPEC_FILENAME),
      JSON.stringify(input.delta_spec, null, 2),
      "utf8"
    );
  } catch (error) {
    throw new GenerateDeltaSpecError(
      "artifact_write_failed",
      "Failed writing delta_spec artifact.",
      error
    );
  }
}

function normalizeText(value?: string): string {
  return (value ?? "").trim();
}
