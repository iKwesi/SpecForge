import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import type { ArtifactMetadata, ArtifactVersion } from "../artifacts/types.js";
import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata
} from "../artifacts/versioning.js";
import type { ProjectMode } from "../contracts/domain.js";
import type { OperationContract } from "../contracts/operation.js";

const REPO_PROFILE_FILENAME = "repo_profile.json";
const DEFAULT_MAX_FILES = 200;
const DEFAULT_IGNORED_DIRECTORIES = [
  ".git",
  ".specforge",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next"
] as const;

const TOOLING_MARKER_MAP: Record<string, string[]> = {
  "package.json": ["node"],
  "pnpm-lock.yaml": ["pnpm"],
  "pnpm-workspace.yaml": ["pnpm"],
  "tsconfig.json": ["typescript"],
  "go.mod": ["go"],
  "pyproject.toml": ["python"],
  "requirements.txt": ["python"],
  "Cargo.toml": ["rust"],
  "pom.xml": ["java"],
  "build.gradle": ["java"],
  "build.gradle.kts": ["java"],
  "Gemfile": ["ruby"],
  "composer.json": ["php"],
  "Dockerfile": ["docker"]
};

export type ProfileRepositoryErrorCode =
  | "invalid_mode"
  | "repository_not_found"
  | "scan_failed"
  | "artifact_write_failed";

export class ProfileRepositoryError extends Error {
  readonly code: ProfileRepositoryErrorCode;
  readonly details?: unknown;

  constructor(code: ProfileRepositoryErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ProfileRepositoryError";
    this.code = code;
    this.details = details;
  }
}

export interface ProfileRepositoryInput {
  project_mode: ProjectMode;
  repository_root: string;
  artifact_dir?: string;
  max_files?: number;
  ignore_directories?: string[];
  created_timestamp?: Date;
}

export interface ExtensionCount {
  extension: string;
  count: number;
}

export interface RepoProfileEvidence {
  top_level_entries: string[];
  sampled_files: string[];
  extension_counts: ExtensionCount[];
  detected_manifests: string[];
  detected_tooling: string[];
}

export interface RepoProfileScan {
  max_files: number;
  scanned_file_count: number;
  truncated: boolean;
  ignored_directories: string[];
}

export interface RepoProfileArtifact {
  kind: "repo_profile";
  metadata: ArtifactMetadata;
  project_mode: "existing-repo";
  repository_root: string;
  scan: RepoProfileScan;
  evidence: RepoProfileEvidence;
}

export interface ProfileRepositoryResult {
  repo_profile: RepoProfileArtifact;
}

export const PROFILE_REPOSITORY_OPERATION_CONTRACT: OperationContract<
  ProfileRepositoryInput,
  ProfileRepositoryResult
> = {
  name: "operation.profileRepository",
  version: "v1",
  purpose: "Generate bounded deterministic repository profile artifacts for existing-repo mode.",
  inputs_schema: {} as ProfileRepositoryInput,
  outputs_schema: {} as ProfileRepositoryResult,
  side_effects: ["writes .specforge/repo_profile.json"],
  invariants: [
    "Profile evidence is derived from repository file-system evidence only.",
    "Repository scan is bounded by max_files with deterministic ordering.",
    "Ignored directories are excluded from recursive file evidence."
  ],
  idempotency_expectations: [
    "Given unchanged repository state and scan options, profile evidence shape is deterministic."
  ],
  failure_modes: ["invalid_mode", "repository_not_found", "scan_failed", "artifact_write_failed"],
  observability_fields: [
    "repository_root",
    "scanned_file_count",
    "truncated",
    "detected_tooling",
    "repo_profile_version"
  ]
};

export async function runProfileRepository(
  input: ProfileRepositoryInput
): Promise<ProfileRepositoryResult> {
  if (input.project_mode !== "existing-repo") {
    throw new ProfileRepositoryError(
      "invalid_mode",
      "profileRepository requires project_mode=existing-repo."
    );
  }

  await ensureRepositoryRootExists(input.repository_root);

  const maxFiles = normalizeMaxFiles(input.max_files);
  const ignoredDirectories = normalizeIgnoredDirectories(input.ignore_directories);
  const evidence = await collectRepositoryEvidence({
    repository_root: input.repository_root,
    max_files: maxFiles,
    ignored_directories: ignoredDirectories
  });

  const scan: RepoProfileScan = {
    max_files: maxFiles,
    scanned_file_count: evidence.sampled_files.length,
    truncated: evidence.truncated,
    ignored_directories: [...ignoredDirectories]
  };

  const previousVersion = await readExistingRepoProfileVersion(
    resolveArtifactDirectory(input.repository_root, input.artifact_dir)
  );

  const content = JSON.stringify({
    repository_root: input.repository_root,
    project_mode: "existing-repo",
    scan,
    evidence: {
      top_level_entries: evidence.top_level_entries,
      sampled_files: evidence.sampled_files,
      extension_counts: evidence.extension_counts,
      detected_manifests: evidence.detected_manifests,
      detected_tooling: evidence.detected_tooling
    }
  });

  const metadata = createRepoProfileMetadata({
    content,
    ...(previousVersion ? { previous_version: previousVersion } : {}),
    ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
  });

  const repoProfile: RepoProfileArtifact = {
    kind: "repo_profile",
    metadata,
    project_mode: "existing-repo",
    repository_root: input.repository_root,
    scan,
    evidence: {
      top_level_entries: evidence.top_level_entries,
      sampled_files: evidence.sampled_files,
      extension_counts: evidence.extension_counts,
      detected_manifests: evidence.detected_manifests,
      detected_tooling: evidence.detected_tooling
    }
  };

  await writeRepoProfileArtifact({
    artifact_dir: resolveArtifactDirectory(input.repository_root, input.artifact_dir),
    repo_profile: repoProfile
  });

  return {
    repo_profile: repoProfile
  };
}

async function ensureRepositoryRootExists(repositoryRoot: string): Promise<void> {
  try {
    const stats = await lstat(repositoryRoot);
    if (!stats.isDirectory()) {
      throw new ProfileRepositoryError(
        "repository_not_found",
        `Repository root is not a directory: ${repositoryRoot}`
      );
    }
  } catch (error) {
    if (error instanceof ProfileRepositoryError) {
      throw error;
    }

    throw new ProfileRepositoryError(
      "repository_not_found",
      `Repository root was not found: ${repositoryRoot}`,
      error
    );
  }
}

function normalizeMaxFiles(maxFiles?: number): number {
  if (maxFiles === undefined) {
    return DEFAULT_MAX_FILES;
  }

  if (!Number.isInteger(maxFiles) || maxFiles <= 0) {
    throw new ProfileRepositoryError("scan_failed", "max_files must be a positive integer.");
  }

  return maxFiles;
}

function normalizeIgnoredDirectories(ignoreDirectories?: string[]): string[] {
  const value = ignoreDirectories && ignoreDirectories.length > 0
    ? [...ignoreDirectories]
    : [...DEFAULT_IGNORED_DIRECTORIES];

  return [...new Set(value)].sort((left, right) => left.localeCompare(right));
}

interface CollectRepositoryEvidenceInput {
  repository_root: string;
  max_files: number;
  ignored_directories: string[];
}

interface CollectedRepositoryEvidence {
  top_level_entries: string[];
  sampled_files: string[];
  extension_counts: ExtensionCount[];
  detected_manifests: string[];
  detected_tooling: string[];
  truncated: boolean;
}

async function collectRepositoryEvidence(
  input: CollectRepositoryEvidenceInput
): Promise<CollectedRepositoryEvidence> {
  const ignored = new Set(input.ignored_directories);
  const extensionCounts = new Map<string, number>();
  const manifests = new Set<string>();
  const tooling = new Set<string>();
  const sampledFiles: string[] = [];
  let truncated = false;

  try {
    const topLevelEntries = await readdir(input.repository_root, { withFileTypes: true });
    const topLevelNames = topLevelEntries
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    async function walkDirectory(currentAbsolutePath: string): Promise<void> {
      if (sampledFiles.length >= input.max_files) {
        truncated = true;
        return;
      }

      const entries = (await readdir(currentAbsolutePath, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (sampledFiles.length >= input.max_files) {
          truncated = true;
          return;
        }

        const absolutePath = join(currentAbsolutePath, entry.name);
        const relativePath = toNormalizedRelativePath(input.repository_root, absolutePath);

        if (entry.isDirectory()) {
          if (ignored.has(entry.name)) {
            continue;
          }

          await walkDirectory(absolutePath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        sampledFiles.push(relativePath);

        const extension = normalizeExtension(entry.name);
        extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);

        const markerTooling = TOOLING_MARKER_MAP[entry.name];
        if (markerTooling) {
          manifests.add(relativePath);
          for (const tool of markerTooling) {
            tooling.add(tool);
          }
        }
      }
    }

    await walkDirectory(input.repository_root);

    return {
      top_level_entries: topLevelNames,
      sampled_files: [...sampledFiles],
      extension_counts: [...extensionCounts.entries()]
        .map(([extension, count]) => ({ extension, count }))
        .sort((left, right) => {
          if (right.count !== left.count) {
            return right.count - left.count;
          }
          return left.extension.localeCompare(right.extension);
        }),
      detected_manifests: [...manifests].sort((left, right) => left.localeCompare(right)),
      detected_tooling: [...tooling].sort((left, right) => left.localeCompare(right)),
      truncated
    };
  } catch (error) {
    throw new ProfileRepositoryError(
      "scan_failed",
      "Failed while scanning repository for profile evidence.",
      error
    );
  }
}

function toNormalizedRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).replace(/\\/g, "/");
}

function normalizeExtension(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  return extension.length > 0 ? extension : "<none>";
}

function resolveArtifactDirectory(repositoryRoot: string, artifactDir?: string): string {
  return artifactDir ?? join(repositoryRoot, ".specforge");
}

interface CreateRepoProfileMetadataInput {
  previous_version?: ArtifactVersion;
  content: string;
  created_timestamp?: Date;
}

function createRepoProfileMetadata(input: CreateRepoProfileMetadataInput): ArtifactMetadata {
  if (!input.previous_version) {
    return createInitialArtifactMetadata({
      artifactId: "repo_profile",
      generator: "operation.profileRepository",
      sourceRefs: [],
      content: input.content,
      ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
    });
  }

  return createNextArtifactMetadata({
    previous: {
      artifact_id: "repo_profile",
      artifact_version: input.previous_version,
      created_timestamp: "1970-01-01T00:00:00.000Z",
      generator: "operation.profileRepository",
      source_refs: [],
      checksum: "0".repeat(64)
    },
    generator: "operation.profileRepository",
    sourceRefs: [],
    content: input.content,
    ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
  });
}

async function readExistingRepoProfileVersion(
  artifactDir: string
): Promise<ArtifactVersion | undefined> {
  try {
    const raw = await readFile(join(artifactDir, REPO_PROFILE_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<RepoProfileArtifact>;
    const version = parsed.metadata?.artifact_version;

    if (typeof version === "string" && /^v\d+$/.test(version)) {
      return version as ArtifactVersion;
    }

    throw new ProfileRepositoryError(
      "artifact_write_failed",
      "Existing repo_profile has invalid metadata.artifact_version."
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof ProfileRepositoryError) {
      throw error;
    }

    throw new ProfileRepositoryError(
      "artifact_write_failed",
      "Failed to read existing repo_profile metadata.",
      error
    );
  }
}

interface WriteRepoProfileArtifactInput {
  artifact_dir: string;
  repo_profile: RepoProfileArtifact;
}

async function writeRepoProfileArtifact(input: WriteRepoProfileArtifactInput): Promise<void> {
  try {
    await mkdir(input.artifact_dir, { recursive: true });
    await writeFile(
      join(input.artifact_dir, REPO_PROFILE_FILENAME),
      JSON.stringify(input.repo_profile, null, 2),
      "utf8"
    );
  } catch (error) {
    throw new ProfileRepositoryError(
      "artifact_write_failed",
      "Failed writing repo profile artifact.",
      error
    );
  }
}
