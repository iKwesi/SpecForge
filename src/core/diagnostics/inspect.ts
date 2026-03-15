import { join } from "node:path";

import { mergeDryRunReports, type DryRunReport } from "../contracts/dryRun.js";
import type { ArchitectureSummaryArtifact } from "../operations/mapArchitectureFromRepo.js";
import {
  MapArchitectureFromRepoError,
  runMapArchitectureFromRepo,
  type MapArchitectureFromRepoInput,
  type MapArchitectureFromRepoResult
} from "../operations/mapArchitectureFromRepo.js";
import type { RepoProfileArtifact } from "../operations/profileRepository.js";
import {
  ProfileRepositoryError,
  runProfileRepository,
  type ProfileRepositoryInput,
  type ProfileRepositoryResult
} from "../operations/profileRepository.js";
import {
  UpdateArchitectureDocsError,
  runUpdateArchitectureDocs,
  type UpdateArchitectureDocsInput,
  type UpdateArchitectureDocsResult
} from "../operations/updateArchitectureDocs.js";

const STANDARD_MAX_FILES = 200;
const DEEP_MAX_FILES = 1000;

export type InspectScanMode = "standard" | "deep";
export type InspectErrorCode = "profile_failed" | "architecture_failed" | "architecture_docs_failed";

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
  architecture_summary_markdown_path?: string;
  architecture_docs_path?: string;
  repo_profile: RepoProfileArtifact;
  architecture_summary: ArchitectureSummaryArtifact;
  dry_run?: DryRunReport;
}

export interface RunInspectInput {
  repository_root?: string;
  artifact_dir?: string;
  deep?: boolean;
  dry_run?: boolean;
  write_architecture_docs?: boolean;
  docs_path?: string;
  created_timestamp?: Date;
  profile_runner?: (input: ProfileRepositoryInput) => Promise<ProfileRepositoryResult>;
  architecture_runner?: (input: MapArchitectureFromRepoInput) => Promise<MapArchitectureFromRepoResult>;
  architecture_docs_runner?: (
    input: UpdateArchitectureDocsInput
  ) => Promise<UpdateArchitectureDocsResult>;
}

/**
 * Produce bounded repository inspection outputs without modifying application code.
 *
 * By default this orchestration layer writes only the published inspect artifacts
 * under `.specforge` for the inspected repository. When `write_architecture_docs`
 * is enabled, it can also refresh maintained architecture markdown such as
 * `docs/ARCHITECTURE.md` or a caller-provided `docs_path`.
 */
export async function runInspect(input: RunInspectInput = {}): Promise<InspectResult> {
  const repositoryRoot = input.repository_root ?? process.cwd();
  const artifactRoot = input.artifact_dir ?? repositoryRoot;
  const profileArtifactDir = input.artifact_dir ? join(input.artifact_dir, ".specforge") : undefined;
  const scanMode: InspectScanMode = input.deep === true ? "deep" : "standard";
  const maxFiles = scanMode === "deep" ? DEEP_MAX_FILES : STANDARD_MAX_FILES;
  const profileRunner = input.profile_runner ?? runProfileRepository;
  const architectureRunner = input.architecture_runner ?? runMapArchitectureFromRepo;
  const architectureDocsRunner = input.architecture_docs_runner ?? runUpdateArchitectureDocs;
  let dryRun: DryRunReport | undefined;

  let repoProfile: RepoProfileArtifact;
  try {
    const result = await profileRunner({
      project_mode: "existing-repo",
      repository_root: repositoryRoot,
      ...(profileArtifactDir ? { artifact_dir: profileArtifactDir } : {}),
      max_files: maxFiles,
      ...(input.dry_run ? { dry_run: true } : {}),
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    });
    repoProfile = result.repo_profile;
    dryRun = mergeDryRunReports(dryRun, "dry_run" in result ? result.dry_run : undefined);
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
      ...(input.dry_run ? { dry_run: true } : {}),
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    });
    architectureSummary = result.architecture_summary;
    dryRun = mergeDryRunReports(dryRun, "dry_run" in result ? result.dry_run : undefined);
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

  let architectureSummaryMarkdownPath: string | undefined;
  let architectureDocsPath: string | undefined;
  if (input.write_architecture_docs) {
    try {
      const result = await architectureDocsRunner({
        project_mode: "existing-repo",
        repository_root: repositoryRoot,
        repo_profile: repoProfile,
        architecture_summary: architectureSummary,
        artifact_dir: artifactRoot,
        ...(input.docs_path ? { docs_path: input.docs_path } : {}),
        ...(input.dry_run ? { dry_run: true } : {})
      });
      architectureSummaryMarkdownPath = result.architecture_summary_markdown_path;
      architectureDocsPath = result.architecture_docs_path;
      dryRun = mergeDryRunReports(dryRun, "dry_run" in result ? result.dry_run : undefined);
    } catch (error) {
      if (error instanceof UpdateArchitectureDocsError) {
        throw new InspectError(
          "architecture_docs_failed",
          `Architecture docs generation failed: ${error.message}`,
          error
        );
      }

      throw error;
    }
  }

  return {
    scan_mode: scanMode,
    repository_root: repositoryRoot,
    repo_profile_path: join(artifactRoot, ".specforge", "repo_profile.json"),
    architecture_summary_path: join(artifactRoot, ".specforge", "architecture_summary.json"),
    ...(architectureSummaryMarkdownPath
      ? { architecture_summary_markdown_path: architectureSummaryMarkdownPath }
      : {}),
    ...(architectureDocsPath ? { architecture_docs_path: architectureDocsPath } : {}),
    repo_profile: repoProfile,
    architecture_summary: architectureSummary,
    ...(dryRun ? { dry_run: dryRun } : {})
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
    `Architecture Summary Path: ${result.architecture_summary_path}`
  ];

  if (result.architecture_summary_markdown_path) {
    lines.push(`Architecture Summary Markdown Path: ${result.architecture_summary_markdown_path}`);
  }

  if (result.architecture_docs_path) {
    lines.push(`Architecture Docs Path: ${result.architecture_docs_path}`);
  }

  if (result.dry_run) {
    lines.push("", "Dry Run: enabled");
    for (const change of result.dry_run.changes) {
      lines.push(`- ${change.status} ${change.kind}: ${change.target}`);
      lines.push(`  ${change.detail}`);
    }
  }

  lines.push(
    "",
    "Repo Profile Evidence",
    `- scanned_file_count: ${result.repo_profile.scan.scanned_file_count}`,
    `- max_files: ${result.repo_profile.scan.max_files}`,
    `- truncated: ${result.repo_profile.scan.truncated}`,
    `- detected_tooling: ${result.repo_profile.evidence.detected_tooling.join(", ") || "none"}`,
    "",
    "Architecture Subsystems"
  );

  for (const subsystem of result.architecture_summary.subsystems) {
    lines.push(
      `- ${subsystem.id} (${subsystem.file_count} files, ${subsystem.uncertainty} uncertainty)`
    );
  }

  return `${lines.join("\n")}\n`;
}
