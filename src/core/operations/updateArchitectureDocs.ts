import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { createDryRunReport, type DryRunReport } from "../contracts/dryRun.js";
import type { ProjectMode } from "../contracts/domain.js";
import type { OperationContract } from "../contracts/operation.js";
import { renderArchitectureDiagramsMarkdown } from "./architectureDiagrams.js";
import type { ArchitectureSummaryArtifact } from "./mapArchitectureFromRepo.js";
import type { RepoProfileArtifact } from "./profileRepository.js";

const GENERATED_SECTION_ID = "generated-architecture";
const GENERATED_SECTION_START = "<!-- specforge:begin generated-architecture -->";
const GENERATED_SECTION_END = "<!-- specforge:end generated-architecture -->";
const ARCHITECTURE_DOCS_DEFAULT_RELATIVE_PATH = join("docs", "ARCHITECTURE.md");
const ARCHITECTURE_SUMMARY_MARKDOWN_RELATIVE_PATH = join(".specforge", "architecture_summary.md");

export type UpdateArchitectureDocsErrorCode =
  | "invalid_mode"
  | "repository_not_found"
  | "invalid_docs_path"
  | "insufficient_repo_profile"
  | "insufficient_architecture_summary"
  | "artifact_mismatch"
  | "invalid_docs_state"
  | "docs_read_failed"
  | "summary_write_failed"
  | "docs_write_failed";

export class UpdateArchitectureDocsError extends Error {
  readonly code: UpdateArchitectureDocsErrorCode;
  readonly details?: unknown;

  constructor(code: UpdateArchitectureDocsErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "UpdateArchitectureDocsError";
    this.code = code;
    this.details = details;
  }
}

export interface UpdateArchitectureDocsInput {
  project_mode: ProjectMode;
  repository_root: string;
  repo_profile?: RepoProfileArtifact;
  architecture_summary?: ArchitectureSummaryArtifact;
  artifact_dir?: string;
  docs_path?: string;
  dry_run?: boolean;
}

export interface UpdateArchitectureDocsResult {
  architecture_summary_markdown_path: string;
  architecture_docs_path: string;
  architecture_summary_markdown: string;
  architecture_docs_content: string;
  dry_run?: DryRunReport;
}

export const UPDATE_ARCHITECTURE_DOCS_OPERATION_CONTRACT: OperationContract<
  UpdateArchitectureDocsInput,
  UpdateArchitectureDocsResult
> = {
  name: "operation.updateArchitectureDocs",
  version: "v1",
  purpose: "Generate maintained architecture documentation from inspect artifacts.",
  inputs_schema: {} as UpdateArchitectureDocsInput,
  outputs_schema: {} as UpdateArchitectureDocsResult,
  side_effects: [
    "writes .specforge/architecture_summary.md (under artifact_dir when provided)",
    "writes docs/ARCHITECTURE.md (or docs_path when provided)"
  ],
  invariants: [
    "Generated architecture docs are derived only from repo_profile and architecture_summary inputs.",
    "Generated architecture docs include deterministic system-context and subsystem-relationship diagrams.",
    "Managed architecture doc sections preserve surrounding manual content.",
    "Evidence references remain visible in both summary markdown and maintained docs."
  ],
  idempotency_expectations: [
    "Equivalent inspect artifacts produce stable markdown content and managed section output."
  ],
  failure_modes: [
    "invalid_mode",
    "repository_not_found",
    "invalid_docs_path",
    "insufficient_repo_profile",
    "insufficient_architecture_summary",
    "artifact_mismatch",
    "invalid_docs_state",
    "docs_read_failed",
    "summary_write_failed",
    "docs_write_failed"
  ],
  observability_fields: [
    "repository_root",
    "repo_profile_version",
    "architecture_summary_version",
    "architecture_docs_path"
  ]
};

/**
 * Generate maintained architecture documentation from the bounded inspect artifacts.
 *
 * The operation stays intentionally narrow: it does not rescan the repository or
 * infer new subsystem boundaries. It only turns repo_profile and architecture_summary
 * evidence into readable markdown while preserving manual content outside the managed
 * architecture section.
 */
export async function runUpdateArchitectureDocs(
  input: UpdateArchitectureDocsInput
): Promise<UpdateArchitectureDocsResult> {
  ensureSupportedMode(input.project_mode);
  await ensureRepositoryRootExists(input.repository_root);
  const repoProfile = ensureRepoProfile(input.repo_profile);
  const architectureSummary = ensureArchitectureSummary(input.architecture_summary);
  ensureSharedRepositoryRoot(input.repository_root, repoProfile, architectureSummary);

  const artifactDir = input.artifact_dir ?? input.repository_root;
  const architectureSummaryMarkdownPath = join(
    artifactDir,
    ARCHITECTURE_SUMMARY_MARKDOWN_RELATIVE_PATH
  );
  const architectureDocsPath = resolveArchitectureDocsPath(
    input.repository_root,
    input.docs_path
  );
  const architectureSummaryMarkdown = renderArchitectureSummaryMarkdown(repoProfile, architectureSummary);
  const currentDocsContent = await readExistingDocs(architectureDocsPath);
  const architectureDocsContent = renderArchitectureDocsContent(
    currentDocsContent,
    repoProfile,
    architectureSummary
  );

  if (!input.dry_run) {
    await writeArchitectureSummaryMarkdown(architectureSummaryMarkdownPath, architectureSummaryMarkdown);
    await writeArchitectureDocs(architectureDocsPath, architectureDocsContent);
  }

  return {
    architecture_summary_markdown_path: architectureSummaryMarkdownPath,
    architecture_docs_path: architectureDocsPath,
    architecture_summary_markdown: architectureSummaryMarkdown,
    architecture_docs_content: architectureDocsContent,
    ...(input.dry_run
      ? {
          dry_run: createDryRunReport([
            {
              status: "planned",
              kind: "file_write",
              target: architectureSummaryMarkdownPath,
              detail: "Would publish generated architecture summary markdown from inspect artifacts."
            },
            {
              status: "planned",
              kind: "file_write",
              target: architectureDocsPath,
              detail: "Would update the managed generated-architecture section in the target architecture docs file."
            }
          ])
        }
      : {})
  };
}

async function ensureRepositoryRootExists(repositoryRoot: string): Promise<void> {
  try {
    const stats = await lstat(repositoryRoot);
    if (!stats.isDirectory()) {
      throw new UpdateArchitectureDocsError(
        "repository_not_found",
        `Repository root is not a directory: ${repositoryRoot}`
      );
    }
  } catch (error) {
    if (error instanceof UpdateArchitectureDocsError) {
      throw error;
    }

    throw new UpdateArchitectureDocsError(
      "repository_not_found",
      `Repository root was not found: ${repositoryRoot}`,
      error
    );
  }
}

function resolveArchitectureDocsPath(repositoryRoot: string, docsPath?: string): string {
  const resolvedDocsPath =
    docsPath === undefined
      ? join(repositoryRoot, ARCHITECTURE_DOCS_DEFAULT_RELATIVE_PATH)
      : isAbsolute(docsPath)
        ? resolve(docsPath)
        : resolve(repositoryRoot, docsPath);

  const relativePath = relative(repositoryRoot, resolvedDocsPath);
  const isParentTraversal =
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath);
  if (isParentTraversal) {
    throw new UpdateArchitectureDocsError(
      "invalid_docs_path",
      "docs_path must stay within repository_root."
    );
  }

  return resolvedDocsPath;
}

function ensureSupportedMode(projectMode: ProjectMode): asserts projectMode is "existing-repo" {
  if (projectMode !== "existing-repo") {
    throw new UpdateArchitectureDocsError(
      "invalid_mode",
      "updateArchitectureDocs only supports existing-repo mode."
    );
  }
}

function ensureRepoProfile(repoProfile?: RepoProfileArtifact): RepoProfileArtifact {
  if (!repoProfile || repoProfile.kind !== "repo_profile") {
    throw new UpdateArchitectureDocsError(
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
    throw new UpdateArchitectureDocsError(
      "insufficient_architecture_summary",
      "Missing or invalid architecture_summary artifact."
    );
  }

  return architectureSummary;
}

function ensureSharedRepositoryRoot(
  repositoryRoot: string,
  repoProfile: RepoProfileArtifact,
  architectureSummary: ArchitectureSummaryArtifact
): void {
  if (
    repoProfile.repository_root !== repositoryRoot ||
    architectureSummary.repository_root !== repositoryRoot
  ) {
    throw new UpdateArchitectureDocsError(
      "artifact_mismatch",
      "repo_profile, architecture_summary, and repository_root must describe the same repository."
    );
  }
}

async function readExistingDocs(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw new UpdateArchitectureDocsError(
      "docs_read_failed",
      `Unable to read architecture docs at ${path}.`,
      error
    );
  }
}

function renderArchitectureSummaryMarkdown(
  repoProfile: RepoProfileArtifact,
  architectureSummary: ArchitectureSummaryArtifact
): string {
  const parts: string[] = [];

  if (architectureSummary.summary_markdown) {
    parts.push(architectureSummary.summary_markdown.trimEnd());
  }

  const diagramsSection = renderArchitectureDiagramsMarkdown(repoProfile, architectureSummary);
  if (parts.length > 0) {
    parts.push("");
  }
  parts.push(diagramsSection);

  const evidenceSection = renderEvidenceSection(repoProfile, architectureSummary);
  if (evidenceSection.trim().length > 0) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push(evidenceSection);
  }

  return parts.join("\n").trimEnd();
}

function renderArchitectureDocsContent(
  currentDocsContent: string | undefined,
  repoProfile: RepoProfileArtifact,
  architectureSummary: ArchitectureSummaryArtifact
): string {
  const generatedSection = renderManagedGeneratedSection(repoProfile, architectureSummary);
  const existingDocs = currentDocsContent ?? "# Architecture\n";

  return injectManagedSection(existingDocs, generatedSection);
}

function renderManagedGeneratedSection(
  repoProfile: RepoProfileArtifact,
  architectureSummary: ArchitectureSummaryArtifact
): string {
  const diagramsSection = renderArchitectureDiagramsMarkdown(repoProfile, architectureSummary);
  const evidenceSection = renderEvidenceSection(repoProfile, architectureSummary);

  return [
    GENERATED_SECTION_START,
    diagramsSection,
    "",
    evidenceSection,
    GENERATED_SECTION_END
  ].join("\n");
}

function renderEvidenceSection(
  repoProfile: RepoProfileArtifact,
  architectureSummary: ArchitectureSummaryArtifact
): string {
  const lines = [
    "## Repository Evidence Snapshot",
    "",
    "Repository Root: .",
    `Repo Profile: ${repoProfile.metadata.artifact_id}@${repoProfile.metadata.artifact_version}`,
    `Architecture Summary: ${architectureSummary.metadata.artifact_id}@${architectureSummary.metadata.artifact_version}`,
    "",
    "### Scan Evidence",
    `- scanned_file_count: ${repoProfile.scan.scanned_file_count}`,
    `- max_files: ${repoProfile.scan.max_files}`,
    `- truncated: ${repoProfile.scan.truncated}`,
    `- detected_tooling: ${repoProfile.evidence.detected_tooling.join(", ") || "none"}`,
    `- detected_manifests: ${repoProfile.evidence.detected_manifests.join(", ") || "none"}`,
    "",
    "### Contracts",
    `- repo_profile: emitted by ${repoProfile.metadata.generator} and captures bounded scan evidence, tooling, and sampled paths.`,
    `- architecture_summary: emitted by ${architectureSummary.metadata.generator} and maps subsystem boundaries from repo_profile evidence refs.`,
    "",
    "### Artifact Flow",
    `1. ${repoProfile.metadata.generator} publishes ${repoProfile.metadata.artifact_id}@${repoProfile.metadata.artifact_version}.`,
    `2. ${architectureSummary.metadata.generator} consumes ${repoProfile.metadata.artifact_id}@${repoProfile.metadata.artifact_version} and publishes ${architectureSummary.metadata.artifact_id}@${architectureSummary.metadata.artifact_version}.`,
    "3. operation.updateArchitectureDocs turns those artifacts into maintained markdown without rescanning the repository.",
    "",
    "### Subsystems"
  ];

  for (const subsystem of architectureSummary.subsystems) {
    lines.push("");
    lines.push(`### Subsystem: ${subsystem.id}`);
    lines.push(`- responsibility: ${subsystem.inferred_responsibility}`);
    lines.push(`- uncertainty: ${subsystem.uncertainty}`);
    lines.push(`- file_count: ${subsystem.file_count}`);
    lines.push("- evidence_refs:");
    for (const evidenceRef of subsystem.evidence_refs) {
      lines.push(`  - ${evidenceRef}`);
    }
  }

  return lines.join("\n");
}

function injectManagedSection(existingDocs: string, generatedSection: string): string {
  const startIndex = existingDocs.indexOf(GENERATED_SECTION_START);
  const secondStartIndex =
    startIndex >= 0
      ? existingDocs.indexOf(GENERATED_SECTION_START, startIndex + GENERATED_SECTION_START.length)
      : -1;
  const endIndex = existingDocs.indexOf(GENERATED_SECTION_END);
  const secondEndIndex =
    endIndex >= 0
      ? existingDocs.indexOf(GENERATED_SECTION_END, endIndex + GENERATED_SECTION_END.length)
      : -1;

  if (secondStartIndex >= 0 || secondEndIndex >= 0) {
    throw new UpdateArchitectureDocsError(
      "invalid_docs_state",
      `Architecture docs contain multiple managed section markers for ${GENERATED_SECTION_ID}.`
    );
  }

  if ((startIndex >= 0 && endIndex < 0) || (startIndex < 0 && endIndex >= 0) || endIndex < startIndex) {
    throw new UpdateArchitectureDocsError(
      "invalid_docs_state",
      `Architecture docs contain malformed managed section markers for ${GENERATED_SECTION_ID}.`
    );
  }

  if (startIndex >= 0 && endIndex >= 0) {
    const sectionEnd = endIndex + GENERATED_SECTION_END.length;
    const before = existingDocs.slice(0, startIndex);
    const after = existingDocs.slice(sectionEnd);
    let result = before;

    // Preserve manual content byte-for-byte and only add separator newlines where
    // the managed section would otherwise run into surrounding content.
    if (result.length > 0 && !result.endsWith("\n")) {
      result += "\n";
    }

    result += generatedSection;

    if (after.length > 0 && !result.endsWith("\n") && !after.startsWith("\n")) {
      result += "\n";
    }

    result += after;
    return result;
  }

  if (existingDocs.length === 0) {
    return generatedSection;
  }

  let result = existingDocs;
  if (!result.endsWith("\n")) {
    result += "\n";
  }

  if (!result.endsWith("\n\n")) {
    result += "\n";
  }

  result += generatedSection;
  return result;
}

async function writeArchitectureSummaryMarkdown(path: string, markdown: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${markdown}\n`, "utf8");
  } catch (error) {
    throw new UpdateArchitectureDocsError(
      "summary_write_failed",
      `Unable to write generated architecture summary markdown at ${path}.`,
      error
    );
  }
}

async function writeArchitectureDocs(path: string, markdown: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, markdown, "utf8");
  } catch (error) {
    throw new UpdateArchitectureDocsError(
      "docs_write_failed",
      `Unable to write architecture docs at ${path}.`,
      error
    );
  }
}
