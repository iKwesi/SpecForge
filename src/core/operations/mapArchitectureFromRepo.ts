import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMetadata, ArtifactSourceRef, ArtifactVersion } from "../artifacts/types.js";
import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata
} from "../artifacts/versioning.js";
import type { ProjectMode } from "../contracts/domain.js";
import type { OperationContract } from "../contracts/operation.js";
import type { RepoProfileArtifact } from "./profileRepository.js";

const ARCHITECTURE_SUMMARY_FILENAME = "architecture_summary.json";

export type ArchitectureUncertainty = "low" | "medium";

export interface ArchitectureSubsystem {
  id: string;
  label: string;
  inferred_responsibility: string;
  file_count: number;
  evidence_refs: string[];
  uncertainty: ArchitectureUncertainty;
}

export interface ArchitectureSummaryArtifact {
  kind: "architecture_summary";
  metadata: ArtifactMetadata;
  project_mode: "existing-repo";
  repository_root: string;
  subsystems: ArchitectureSubsystem[];
  summary_markdown: string;
}

export interface MapArchitectureFromRepoInput {
  project_mode: ProjectMode;
  repo_profile?: RepoProfileArtifact;
  artifact_dir?: string;
  created_timestamp?: Date;
}

export interface MapArchitectureFromRepoResult {
  architecture_summary: ArchitectureSummaryArtifact;
}

export type MapArchitectureFromRepoErrorCode =
  | "invalid_mode"
  | "insufficient_repo_profile"
  | "artifact_write_failed";

export class MapArchitectureFromRepoError extends Error {
  readonly code: MapArchitectureFromRepoErrorCode;
  readonly details?: unknown;

  constructor(code: MapArchitectureFromRepoErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "MapArchitectureFromRepoError";
    this.code = code;
    this.details = details;
  }
}

export const MAP_ARCHITECTURE_FROM_REPO_OPERATION_CONTRACT: OperationContract<
  MapArchitectureFromRepoInput,
  MapArchitectureFromRepoResult
> = {
  name: "operation.mapArchitectureFromRepo",
  version: "v1",
  purpose: "Derive deterministic architecture summaries from repository profile evidence.",
  inputs_schema: {} as MapArchitectureFromRepoInput,
  outputs_schema: {} as MapArchitectureFromRepoResult,
  side_effects: ["writes .specforge/architecture_summary.json"],
  invariants: [
    "Architecture summaries are derived from repo_profile evidence only.",
    "Subsystem boundaries include explicit evidence references.",
    "Uncertainty markers are tied to evidence density."
  ],
  idempotency_expectations: [
    "Equivalent repo_profile inputs produce stable subsystem ordering and summary output."
  ],
  failure_modes: ["invalid_mode", "insufficient_repo_profile", "artifact_write_failed"],
  observability_fields: [
    "repository_root",
    "subsystem_count",
    "repo_profile_version",
    "architecture_summary_version"
  ]
};

/**
 * Build an architecture summary from repo_profile evidence without rescanning the repository.
 * The operation intentionally stays bounded and deterministic: it groups sampled paths into
 * likely subsystem boundaries and records the exact evidence that drove each inference.
 */
export async function runMapArchitectureFromRepo(
  input: MapArchitectureFromRepoInput
): Promise<MapArchitectureFromRepoResult> {
  if (input.project_mode !== "existing-repo") {
    throw new MapArchitectureFromRepoError(
      "invalid_mode",
      "mapArchitectureFromRepo requires project_mode=existing-repo."
    );
  }

  const repoProfile = ensureRepoProfile(input.repo_profile);
  const subsystems = deriveSubsystems(repoProfile);
  const sourceRefs: ArtifactSourceRef[] = [
    {
      artifact_id: repoProfile.metadata.artifact_id,
      artifact_version: repoProfile.metadata.artifact_version
    }
  ];

  const previousVersion = await readExistingArchitectureSummaryVersion(input.artifact_dir);
  const summaryMarkdown = renderArchitectureSummaryMarkdown(subsystems, repoProfile);
  const metadata = createArchitectureSummaryMetadata({
    source_refs: sourceRefs,
    content: JSON.stringify({
      repository_root: repoProfile.repository_root,
      subsystems,
      summary_markdown: summaryMarkdown
    }),
    ...(previousVersion ? { previous_version: previousVersion } : {}),
    ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
  });

  const architectureSummary: ArchitectureSummaryArtifact = {
    kind: "architecture_summary",
    metadata,
    project_mode: "existing-repo",
    repository_root: repoProfile.repository_root,
    subsystems,
    summary_markdown: summaryMarkdown
  };

  if (input.artifact_dir) {
    await writeArchitectureSummaryArtifact({
      artifact_dir: input.artifact_dir,
      architecture_summary: architectureSummary
    });
  }

  return {
    architecture_summary: architectureSummary
  };
}

function ensureRepoProfile(repoProfile?: RepoProfileArtifact): RepoProfileArtifact {
  if (!repoProfile || repoProfile.kind !== "repo_profile") {
    throw new MapArchitectureFromRepoError(
      "insufficient_repo_profile",
      "Missing or invalid repo_profile artifact."
    );
  }

  return repoProfile;
}

/**
 * We infer boundaries from the first two path segments. That keeps the heuristic narrow,
 * deterministic, and easy to reason about while still surfacing useful subsystem shapes.
 */
function deriveSubsystems(repoProfile: RepoProfileArtifact): ArchitectureSubsystem[] {
  const groupedEvidence = new Map<string, string[]>();

  for (const sampledFile of repoProfile.evidence.sampled_files) {
    const boundary = inferBoundaryFromPath(sampledFile);
    if (!boundary) {
      continue;
    }

    const existing = groupedEvidence.get(boundary) ?? [];
    existing.push(sampledFile);
    groupedEvidence.set(boundary, existing);
  }

  return [...groupedEvidence.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([boundary, evidenceRefs]) => {
      const sortedEvidence = [...new Set(evidenceRefs)].sort((left, right) => left.localeCompare(right));
      return {
        id: boundary,
        label: boundary,
        inferred_responsibility: inferResponsibility(boundary),
        file_count: sortedEvidence.length,
        evidence_refs: sortedEvidence,
        uncertainty: sortedEvidence.length >= 2 ? "low" : "medium"
      };
    });
}

function inferBoundaryFromPath(sampledFile: string): string | undefined {
  const segments = sampledFile.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return undefined;
  }

  return `${segments[0]}/${segments[1]}`;
}

function inferResponsibility(boundary: string): string {
  if (boundary.includes("/api") || boundary.endsWith("/api")) {
    return "API/backend surface";
  }

  if (boundary.includes("/cli") || boundary.endsWith("/cli")) {
    return "CLI entrypoints";
  }

  if (boundary.startsWith("tests/")) {
    return "Test coverage";
  }

  if (boundary.startsWith("infra/")) {
    return "Infrastructure automation";
  }

  return "General subsystem";
}

function renderArchitectureSummaryMarkdown(
  subsystems: ArchitectureSubsystem[],
  repoProfile: RepoProfileArtifact
): string {
  const lines: string[] = [
    "# Architecture Summary",
    "",
    `Repository Root: ${repoProfile.repository_root}`,
    `Repo Profile Version: ${repoProfile.metadata.artifact_version}`,
    ""
  ];

  for (const subsystem of subsystems) {
    lines.push(`## ${subsystem.id}`);
    lines.push(`Responsibility: ${subsystem.inferred_responsibility}`);
    lines.push(`Uncertainty: ${subsystem.uncertainty}`);
    lines.push("Evidence:");
    for (const evidenceRef of subsystem.evidence_refs) {
      lines.push(`- ${evidenceRef}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

interface CreateArchitectureSummaryMetadataInput {
  source_refs: ArtifactSourceRef[];
  content: string;
  previous_version?: ArtifactVersion;
  created_timestamp?: Date;
}

function createArchitectureSummaryMetadata(
  input: CreateArchitectureSummaryMetadataInput
): ArtifactMetadata {
  if (!input.previous_version) {
    return createInitialArtifactMetadata({
      artifactId: "architecture_summary",
      generator: "operation.mapArchitectureFromRepo",
      sourceRefs: input.source_refs,
      content: input.content,
      ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
    });
  }

  return createNextArtifactMetadata({
    previous: {
      artifact_id: "architecture_summary",
      artifact_version: input.previous_version,
      created_timestamp: "1970-01-01T00:00:00.000Z",
      generator: "operation.mapArchitectureFromRepo",
      source_refs: input.source_refs,
      checksum: "0".repeat(64)
    },
    generator: "operation.mapArchitectureFromRepo",
    sourceRefs: input.source_refs,
    content: input.content,
    ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
  });
}

async function readExistingArchitectureSummaryVersion(
  artifactDir?: string
): Promise<ArtifactVersion | undefined> {
  if (!artifactDir) {
    return undefined;
  }

  try {
    const raw = await readFile(join(artifactDir, ".specforge", ARCHITECTURE_SUMMARY_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<ArchitectureSummaryArtifact>;
    const version = parsed.metadata?.artifact_version;

    if (typeof version === "string" && /^v\d+$/.test(version)) {
      return version as ArtifactVersion;
    }

    throw new MapArchitectureFromRepoError(
      "artifact_write_failed",
      "Existing architecture summary has invalid metadata.artifact_version."
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof MapArchitectureFromRepoError) {
      throw error;
    }

    throw new MapArchitectureFromRepoError(
      "artifact_write_failed",
      "Failed to inspect existing architecture summary artifact.",
      error
    );
  }
}

async function writeArchitectureSummaryArtifact(input: {
  artifact_dir: string;
  architecture_summary: ArchitectureSummaryArtifact;
}): Promise<void> {
  const outputDir = join(input.artifact_dir, ".specforge");

  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, ARCHITECTURE_SUMMARY_FILENAME),
      JSON.stringify(input.architecture_summary, null, 2),
      "utf8"
    );
  } catch (error) {
    throw new MapArchitectureFromRepoError(
      "artifact_write_failed",
      "Failed writing architecture summary artifact.",
      error
    );
  }
}
