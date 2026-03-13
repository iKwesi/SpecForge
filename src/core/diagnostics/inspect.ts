import { join } from "node:path";

import type { ArchitectureSummaryArtifact } from "../operations/mapArchitectureFromRepo.js";
import {
  MapArchitectureFromRepoError,
  runMapArchitectureFromRepo,
  type MapArchitectureFromRepoInput
} from "../operations/mapArchitectureFromRepo.js";
import type { RepoProfileArtifact } from "../operations/profileRepository.js";
import {
  ProfileRepositoryError,
  runProfileRepository,
  type ProfileRepositoryInput
} from "../operations/profileRepository.js";

const STANDARD_MAX_FILES = 200;
const DEEP_MAX_FILES = 1000;

export type InspectScanMode = "standard" | "deep";
export type InspectErrorCode = "profile_failed" | "architecture_failed";

export class InspectError extends Error {
  readonly code: InspectErrorCode;
  readonly details?: unknown;

  constructor(code: InspectErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "InspectError";
    this.code = code;
    this.details = details;
  }
}

export interface InspectResult {
  scan_mode: InspectScanMode;
  repository_root: string;
  repo_profile_path: string;
  architecture_summary_path: string;
  repo_profile: RepoProfileArtifact;
  architecture_summary: ArchitectureSummaryArtifact;
}

export interface RunInspectInput {
  repository_root?: string;
  artifact_dir?: string;
  deep?: boolean;
  created_timestamp?: Date;
  profile_runner?: (input: ProfileRepositoryInput) => Promise<{ repo_profile: RepoProfileArtifact }>;
  architecture_runner?: (
    input: MapArchitectureFromRepoInput
  ) => Promise<{ architecture_summary: ArchitectureSummaryArtifact }>;
}

/**
 * Produce repository inspection artifacts without modifying application code.
 *
 * This orchestration layer intentionally composes the existing bounded repository
 * profiling and architecture mapping operations. The only files written are the
 * published artifacts under .specforge for the inspected repository.
 */
export async function runInspect(input: RunInspectInput = {}): Promise<InspectResult> {
  const repositoryRoot = input.repository_root ?? process.cwd();
  const artifactRoot = input.artifact_dir ?? repositoryRoot;
  const profileArtifactDir = input.artifact_dir ? join(input.artifact_dir, ".specforge") : undefined;
  const scanMode: InspectScanMode = input.deep === true ? "deep" : "standard";
  const maxFiles = scanMode === "deep" ? DEEP_MAX_FILES : STANDARD_MAX_FILES;
  const profileRunner = input.profile_runner ?? runProfileRepository;
  const architectureRunner = input.architecture_runner ?? runMapArchitectureFromRepo;

  let repoProfile: RepoProfileArtifact;
  try {
    const result = await profileRunner({
      project_mode: "existing-repo",
      repository_root: repositoryRoot,
      ...(profileArtifactDir ? { artifact_dir: profileArtifactDir } : {}),
      max_files: maxFiles,
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    });
    repoProfile = result.repo_profile;
  } catch (error) {
    if (error instanceof ProfileRepositoryError) {
      throw new InspectError(
        "profile_failed",
        `Repository profiling failed: ${error.message}`,
        error
      );
    }

    throw error;
  }

  let architectureSummary: ArchitectureSummaryArtifact;
  try {
    const result = await architectureRunner({
      project_mode: "existing-repo",
      repo_profile: repoProfile,
      artifact_dir: artifactRoot,
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    });
    architectureSummary = result.architecture_summary;
  } catch (error) {
    if (error instanceof MapArchitectureFromRepoError) {
      throw new InspectError(
        "architecture_failed",
        `Architecture mapping failed: ${error.message}`,
        error
      );
    }

    throw error;
  }

  return {
    scan_mode: scanMode,
    repository_root: repositoryRoot,
    repo_profile_path: join(artifactRoot, ".specforge", "repo_profile.json"),
    architecture_summary_path: join(artifactRoot, ".specforge", "architecture_summary.json"),
    repo_profile: repoProfile,
    architecture_summary: architectureSummary
  };
}

export function formatInspectReport(result: InspectResult): string {
  const lines = [
    "SpecForge Inspect",
    "",
    `Repository Root: ${result.repository_root}`,
    `Scan Mode: ${result.scan_mode}`,
    `Repo Profile: ${result.repo_profile.metadata.artifact_id}@${result.repo_profile.metadata.artifact_version}`,
    `Architecture Summary: ${result.architecture_summary.metadata.artifact_id}@${result.architecture_summary.metadata.artifact_version}`,
    `Repo Profile Path: ${result.repo_profile_path}`,
    `Architecture Summary Path: ${result.architecture_summary_path}`,
    "",
    "Repo Profile Evidence",
    `- scanned_file_count: ${result.repo_profile.scan.scanned_file_count}`,
    `- max_files: ${result.repo_profile.scan.max_files}`,
    `- truncated: ${result.repo_profile.scan.truncated}`,
    `- detected_tooling: ${result.repo_profile.evidence.detected_tooling.join(", ") || "none"}`,
    "",
    "Architecture Subsystems"
  ];

  for (const subsystem of result.architecture_summary.subsystems) {
    lines.push(
      `- ${subsystem.id} (${subsystem.file_count} files, ${subsystem.uncertainty} uncertainty)`
    );
  }

  return `${lines.join("\n")}\n`;
}
