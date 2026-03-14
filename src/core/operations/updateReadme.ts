import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMetadata, ArtifactVersion } from "../artifacts/types.js";
import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata,
  hashArtifactContent
} from "../artifacts/versioning.js";
import { createDryRunReport, type DryRunReport } from "../contracts/dryRun.js";
import type { ProjectMode } from "../contracts/domain.js";
import type { OperationContract } from "../contracts/operation.js";

const README_FILENAME = "README.md";
const README_RESULT_DIR = join(".specforge", "readme");
const README_RESULT_FILENAME = "update_result.json";
const README_RESULT_ARTIFACT_ID = "readme_update_result.readme";

export type ReadmeRepositoryOwnership = "owned" | "external";
export type ReadmeUpdateChangeStatus = "created" | "updated" | "unchanged";

export type UpdateReadmeErrorCode =
  | "invalid_mode"
  | "invalid_ownership"
  | "repository_not_found"
  | "invalid_section"
  | "invalid_readme_state"
  | "readme_write_failed"
  | "artifact_write_failed";

export class UpdateReadmeError extends Error {
  readonly code: UpdateReadmeErrorCode;
  readonly details?: unknown;

  constructor(code: UpdateReadmeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "UpdateReadmeError";
    this.code = code;
    this.details = details;
  }
}

export interface UpdateReadmeInput {
  project_mode: ProjectMode;
  repository_ownership: ReadmeRepositoryOwnership;
  repository_root: string;
  section_id: string;
  section_title: string;
  section_body: string;
  artifact_dir?: string;
  dry_run?: boolean;
  created_timestamp?: Date;
}

export interface ReadmeUpdateResultArtifact {
  kind: "readme_update_result";
  metadata: ArtifactMetadata;
  project_mode: "greenfield" | "existing-repo";
  repository_ownership: "owned";
  repository_root: string;
  readme_path: string;
  managed_section_id: string;
  change_status: ReadmeUpdateChangeStatus;
  diff_preview: string;
  readme_checksum_before?: string;
  readme_checksum_after: string;
}

export interface UpdateReadmeResult {
  readme_path: string;
  readme_content: string;
  readme_update_result: ReadmeUpdateResultArtifact;
  dry_run?: DryRunReport;
}

export const UPDATE_README_OPERATION_CONTRACT: OperationContract<
  UpdateReadmeInput,
  UpdateReadmeResult
> = {
  name: "operation.updateReadme",
  version: "v1",
  purpose: "Safely update an owned repository README through a scoped managed section.",
  inputs_schema: {} as UpdateReadmeInput,
  outputs_schema: {} as UpdateReadmeResult,
  side_effects: ["writes README.md", "writes .specforge/readme/update_result.json"],
  invariants: [
    "Only owned repositories are eligible for README mutation.",
    "Unrelated README content is preserved outside the managed section markers.",
    "Result artifacts include an explicit diff preview for the scoped README change."
  ],
  idempotency_expectations: [
    "Equivalent README state and managed section input produce stable content and diff output."
  ],
  failure_modes: [
    "invalid_mode",
    "invalid_ownership",
    "repository_not_found",
    "invalid_section",
    "invalid_readme_state",
    "readme_write_failed",
    "artifact_write_failed"
  ],
  observability_fields: [
    "repository_root",
    "managed_section_id",
    "change_status",
    "readme_update_result_version"
  ]
};

/**
 * Update one managed README section while preserving all unrelated human-authored content.
 *
 * v1 intentionally uses explicit markers instead of markdown heuristics so the update
 * boundary is reviewable and deterministic. We either replace the exact managed block
 * for one section id or append a new managed block to the end of the file.
 */
export async function runUpdateReadme(input: UpdateReadmeInput): Promise<UpdateReadmeResult> {
  ensureSupportedMode(input.project_mode);
  ensureOwnedRepository(input.repository_ownership);
  const section = normalizeSection(input);
  await ensureRepositoryRootExists(input.repository_root);

  const readmePath = join(input.repository_root, README_FILENAME);
  const artifactDir = input.artifact_dir ?? input.repository_root;
  const currentReadme = await readExistingReadme(readmePath);
  const renderedSection = renderManagedSection(section);
  const updatePlan = buildReadmeUpdatePlan({
    current_content: currentReadme.content,
    managed_section: renderedSection,
    section_id: section.id
  });

  const resultArtifact = await buildReadmeUpdateResultArtifact({
    project_mode: input.project_mode,
    repository_root: input.repository_root,
    readme_path: readmePath,
    repository_ownership: "owned",
    managed_section_id: section.id,
    change_status: updatePlan.change_status,
    diff_preview: buildDiffPreview(updatePlan.previous_section, renderedSection, section.id),
    readme_checksum_after: hashArtifactContent(updatePlan.next_content),
    artifact_dir: artifactDir,
    ...(currentReadme.content
      ? { readme_checksum_before: hashArtifactContent(currentReadme.content) }
      : {}),
    ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
  });

  if (!input.dry_run) {
    await writeReadme(readmePath, updatePlan.next_content);
    await writeResultArtifact(artifactDir, resultArtifact);
  }

  return {
    readme_path: readmePath,
    readme_content: updatePlan.next_content,
    readme_update_result: resultArtifact,
    ...(input.dry_run
      ? {
          dry_run: createDryRunReport([
            {
              status: "planned",
              kind: "file_write",
              target: readmePath,
              detail: "Would update the managed README section without rewriting unrelated content."
            },
            {
              status: "planned",
              kind: "artifact_write",
              target: join(artifactDir, README_RESULT_DIR, README_RESULT_FILENAME),
              detail: "Would publish a versioned readme_update_result artifact."
            }
          ])
        }
      : {})
  };
}

interface NormalizedSection {
  id: string;
  title: string;
  body: string;
}

function ensureSupportedMode(projectMode: ProjectMode): asserts projectMode is "greenfield" | "existing-repo" {
  if (projectMode !== "greenfield" && projectMode !== "existing-repo") {
    throw new UpdateReadmeError(
      "invalid_mode",
      "updateReadme only supports greenfield and existing-repo modes."
    );
  }
}

function ensureOwnedRepository(
  repositoryOwnership: ReadmeRepositoryOwnership
): asserts repositoryOwnership is "owned" {
  if (repositoryOwnership !== "owned") {
    throw new UpdateReadmeError(
      "invalid_ownership",
      "updateReadme only supports owned repositories."
    );
  }
}

function normalizeSection(input: UpdateReadmeInput): NormalizedSection {
  const id = input.section_id.trim();
  const title = input.section_title.trim();
  const body = input.section_body.trim();

  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new UpdateReadmeError(
      "invalid_section",
      "section_id must contain only lowercase letters, numbers, and dashes."
    );
  }

  if (title.length === 0 || body.length === 0) {
    throw new UpdateReadmeError(
      "invalid_section",
      "section_title and section_body must be non-empty."
    );
  }

  return { id, title, body };
}

async function ensureRepositoryRootExists(repositoryRoot: string): Promise<void> {
  try {
    const stats = await lstat(repositoryRoot);
    if (!stats.isDirectory()) {
      throw new UpdateReadmeError(
        "repository_not_found",
        `Repository root is not a directory: ${repositoryRoot}`
      );
    }
  } catch (error) {
    if (error instanceof UpdateReadmeError) {
      throw error;
    }

    throw new UpdateReadmeError(
      "repository_not_found",
      `Repository root was not found: ${repositoryRoot}`,
      error
    );
  }
}

interface ExistingReadme {
  content?: string;
}

async function readExistingReadme(readmePath: string): Promise<ExistingReadme> {
  try {
    return {
      content: await readFile(readmePath, "utf8")
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw new UpdateReadmeError(
      "readme_write_failed",
      `Unable to read existing README at ${readmePath}.`,
      error
    );
  }
}

function renderManagedSection(section: NormalizedSection): string {
  return [
    getSectionStartMarker(section.id),
    `## ${section.title}`,
    "",
    section.body,
    getSectionEndMarker(section.id)
  ].join("\n");
}

interface BuildReadmeUpdatePlanInput {
  current_content: string | undefined;
  managed_section: string;
  section_id: string;
}

interface ReadmeUpdatePlan {
  next_content: string;
  previous_section?: string;
  change_status: ReadmeUpdateChangeStatus;
}

function buildReadmeUpdatePlan(input: BuildReadmeUpdatePlanInput): ReadmeUpdatePlan {
  const currentContent = input.current_content;
  if (!currentContent) {
    return {
      next_content: `${input.managed_section}\n`,
      change_status: "created"
    };
  }

  const startMarker = getSectionStartMarker(input.section_id);
  const endMarker = getSectionEndMarker(input.section_id);
  const startMatches = countOccurrences(currentContent, startMarker);
  const endMatches = countOccurrences(currentContent, endMarker);

  if (startMatches !== endMatches || startMatches > 1) {
    throw new UpdateReadmeError(
      "invalid_readme_state",
      `README contains malformed managed section markers for ${input.section_id}.`
    );
  }

  if (startMatches === 0) {
    return {
      next_content: appendManagedSection(currentContent, input.managed_section),
      change_status: "updated"
    };
  }

  const startIndex = currentContent.indexOf(startMarker);
  const endIndex = currentContent.indexOf(endMarker, startIndex);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    throw new UpdateReadmeError(
      "invalid_readme_state",
      `README contains malformed managed section markers for ${input.section_id}.`
    );
  }

  const previousSection = currentContent.slice(startIndex, endIndex + endMarker.length);
  const nextContent =
    currentContent.slice(0, startIndex) +
    input.managed_section +
    currentContent.slice(endIndex + endMarker.length);

  return {
    next_content: nextContent,
    previous_section: previousSection,
    change_status: previousSection === input.managed_section ? "unchanged" : "updated"
  };
}

function appendManagedSection(currentContent: string, managedSection: string): string {
  if (currentContent.length === 0) {
    return `${managedSection}\n`;
  }

  const separator = currentContent.endsWith("\n\n")
    ? ""
    : currentContent.endsWith("\n")
      ? "\n"
      : "\n\n";

  return `${currentContent}${separator}${managedSection}\n`;
}

function buildDiffPreview(
  previousSection: string | undefined,
  nextSection: string,
  sectionId: string
): string {
  const lines = ["--- README.md", "+++ README.md", `@@ managed-section:${sectionId} @@`];

  if (previousSection === nextSection) {
    lines.push("  unchanged");
    return `${lines.join("\n")}\n`;
  }

  for (const line of splitLines(previousSection)) {
    lines.push(`- ${line}`);
  }

  for (const line of splitLines(nextSection)) {
    lines.push(`+ ${line}`);
  }

  return `${lines.join("\n")}\n`;
}

function splitLines(content?: string): string[] {
  if (!content) {
    return [];
  }

  return content.replace(/\n$/, "").split("\n");
}

interface BuildResultArtifactInput {
  project_mode: "greenfield" | "existing-repo";
  repository_ownership: "owned";
  repository_root: string;
  readme_path: string;
  managed_section_id: string;
  change_status: ReadmeUpdateChangeStatus;
  diff_preview: string;
  readme_checksum_before?: string;
  readme_checksum_after: string;
  artifact_dir: string;
  created_timestamp?: Date;
}

async function buildReadmeUpdateResultArtifact(
  input: BuildResultArtifactInput
): Promise<ReadmeUpdateResultArtifact> {
  const previousVersion = await readExistingResultVersion(input.artifact_dir);
  const content = JSON.stringify({
    repository_root: input.repository_root,
    readme_path: input.readme_path,
    managed_section_id: input.managed_section_id,
    change_status: input.change_status,
    diff_preview: input.diff_preview,
    readme_checksum_before: input.readme_checksum_before,
    readme_checksum_after: input.readme_checksum_after
  });

  const metadata = previousVersion
    ? createNextArtifactMetadata({
        previous: {
          artifact_id: README_RESULT_ARTIFACT_ID,
          artifact_version: previousVersion,
          created_timestamp: "1970-01-01T00:00:00.000Z",
          generator: "operation.updateReadme",
          source_refs: [],
          checksum: "0".repeat(64)
        },
        generator: "operation.updateReadme",
        sourceRefs: [],
        content,
        ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
      })
    : createInitialArtifactMetadata({
        artifactId: README_RESULT_ARTIFACT_ID,
        generator: "operation.updateReadme",
        sourceRefs: [],
        content,
        ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
      });

  return {
    kind: "readme_update_result",
    metadata,
    project_mode: input.project_mode,
    repository_ownership: input.repository_ownership,
    repository_root: input.repository_root,
    readme_path: input.readme_path,
    managed_section_id: input.managed_section_id,
    change_status: input.change_status,
    diff_preview: input.diff_preview,
    ...(input.readme_checksum_before ? { readme_checksum_before: input.readme_checksum_before } : {}),
    readme_checksum_after: input.readme_checksum_after
  };
}

async function readExistingResultVersion(
  artifactDir: string
): Promise<ArtifactVersion | undefined> {
  try {
    const raw = await readFile(join(artifactDir, README_RESULT_DIR, README_RESULT_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<ReadmeUpdateResultArtifact>;
    const version = parsed.metadata?.artifact_version;

    if (typeof version === "string" && /^v\d+$/.test(version)) {
      return version as ArtifactVersion;
    }

    throw new UpdateReadmeError(
      "artifact_write_failed",
      "Existing readme update result has invalid metadata.artifact_version."
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof UpdateReadmeError) {
      throw error;
    }

    throw new UpdateReadmeError(
      "artifact_write_failed",
      "Unable to inspect existing README result artifact.",
      error
    );
  }
}

async function writeReadme(readmePath: string, content: string): Promise<void> {
  try {
    await writeFile(readmePath, content, "utf8");
  } catch (error) {
    throw new UpdateReadmeError(
      "readme_write_failed",
      `Failed to write README at ${readmePath}.`,
      error
    );
  }
}

async function writeResultArtifact(
  artifactDir: string,
  artifact: ReadmeUpdateResultArtifact
): Promise<void> {
  try {
    const outputDir = join(artifactDir, README_RESULT_DIR);
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, README_RESULT_FILENAME),
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8"
    );
  } catch (error) {
    throw new UpdateReadmeError(
      "artifact_write_failed",
      "Failed to write README result artifact.",
      error
    );
  }
}

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function getSectionStartMarker(sectionId: string): string {
  return `<!-- specforge:managed-section:${sectionId}:start -->`;
}

function getSectionEndMarker(sectionId: string): string {
  return `<!-- specforge:managed-section:${sectionId}:end -->`;
}
