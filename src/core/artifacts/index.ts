import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ArtifactVersion } from "./types.js";

export interface ArtifactIndexEntry {
  artifact_id: string;
  versions: ArtifactVersion[];
  latest_version: ArtifactVersion;
}

export interface ArtifactIndex {
  schema_version: "v1";
  entries: ArtifactIndexEntry[];
}

export interface RegisterArtifactVersionInput {
  artifact_id: string;
  artifact_version: ArtifactVersion;
}

export interface ResolveArtifactVersionInput {
  artifact_id: string;
  requested_version?: ArtifactVersion;
}

export type ArtifactIndexErrorCode = "invalid_index" | "read_failed" | "write_failed";

export class ArtifactIndexError extends Error {
  readonly code: ArtifactIndexErrorCode;
  readonly details?: unknown;

  constructor(code: ArtifactIndexErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ArtifactIndexError";
    this.code = code;
    this.details = details;
  }
}

export function createArtifactIndex(): ArtifactIndex {
  return {
    schema_version: "v1",
    entries: []
  };
}

export function registerArtifactVersion(
  index: ArtifactIndex,
  input: RegisterArtifactVersionInput
): ArtifactIndex {
  if (input.artifact_id.trim().length === 0) {
    throw new ArtifactIndexError("invalid_index", "artifact_id must be non-empty.");
  }

  ensureArtifactVersion(input.artifact_version);

  const byArtifact = new Map<string, ArtifactVersion[]>();

  for (const entry of normalizeArtifactIndex(index).entries) {
    byArtifact.set(entry.artifact_id, [...entry.versions]);
  }

  const existing = byArtifact.get(input.artifact_id) ?? [];
  if (!existing.includes(input.artifact_version)) {
    existing.push(input.artifact_version);
  }
  byArtifact.set(input.artifact_id, sortArtifactVersions(existing));

  return buildIndexFromMap(byArtifact);
}

export function resolveArtifactVersion(
  index: ArtifactIndex,
  input: ResolveArtifactVersionInput
): ArtifactVersion | undefined {
  const normalized = normalizeArtifactIndex(index);
  const entry = normalized.entries.find((current) => current.artifact_id === input.artifact_id);

  if (!entry) {
    return undefined;
  }

  if (!input.requested_version) {
    return entry.latest_version;
  }

  return entry.versions.includes(input.requested_version) ? input.requested_version : undefined;
}

export function buildArtifactVersionIndex(index: ArtifactIndex): Record<string, ArtifactVersion> {
  const normalized = normalizeArtifactIndex(index);
  const lookup: Record<string, ArtifactVersion> = {};

  for (const entry of normalized.entries) {
    lookup[entry.artifact_id] = entry.latest_version;
  }

  return lookup;
}

export async function readArtifactIndex(filePath: string): Promise<ArtifactIndex> {
  try {
    const raw = await readFile(filePath, "utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ArtifactIndexError("invalid_index", "Artifact index JSON is invalid.", error);
    }

    return normalizeArtifactIndex(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createArtifactIndex();
    }

    if (error instanceof ArtifactIndexError) {
      throw error;
    }

    throw new ArtifactIndexError("read_failed", "Failed to read artifact index file.", error);
  }
}

export async function writeArtifactIndex(
  filePath: string,
  index: ArtifactIndex
): Promise<void> {
  const normalized = normalizeArtifactIndex(index);

  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new ArtifactIndexError("write_failed", "Failed to write artifact index file.", error);
  }
}

function normalizeArtifactIndex(index: unknown): ArtifactIndex {
  if (!isRecord(index)) {
    throw new ArtifactIndexError("invalid_index", "Artifact index must be an object.");
  }

  if (index.schema_version !== "v1") {
    throw new ArtifactIndexError("invalid_index", "Artifact index schema_version must be v1.");
  }

  if (!Array.isArray(index.entries)) {
    throw new ArtifactIndexError("invalid_index", "Artifact index entries must be an array.");
  }

  const byArtifact = new Map<string, ArtifactVersion[]>();

  for (const rawEntry of index.entries) {
    if (!isRecord(rawEntry)) {
      throw new ArtifactIndexError("invalid_index", "Artifact index entry must be an object.");
    }

    if (typeof rawEntry.artifact_id !== "string" || rawEntry.artifact_id.trim().length === 0) {
      throw new ArtifactIndexError(
        "invalid_index",
        "Artifact index entry artifact_id must be a non-empty string."
      );
    }

    if (!Array.isArray(rawEntry.versions) || rawEntry.versions.length === 0) {
      throw new ArtifactIndexError(
        "invalid_index",
        `Artifact index entry ${rawEntry.artifact_id} must include non-empty versions.`
      );
    }

    const versions = rawEntry.versions.map((version) => ensureArtifactVersion(version));
    const canonicalVersions = sortArtifactVersions(versions);

    if (typeof rawEntry.latest_version !== "string") {
      throw new ArtifactIndexError(
        "invalid_index",
        `Artifact index entry ${rawEntry.artifact_id} latest_version must be a string.`
      );
    }

    const latest = ensureArtifactVersion(rawEntry.latest_version);
    const expectedLatest = canonicalVersions[canonicalVersions.length - 1];
    if (latest !== expectedLatest) {
      throw new ArtifactIndexError(
        "invalid_index",
        `Artifact index entry ${rawEntry.artifact_id} latest_version does not match versions.`
      );
    }

    byArtifact.set(rawEntry.artifact_id, canonicalVersions);
  }

  return buildIndexFromMap(byArtifact);
}

function buildIndexFromMap(byArtifact: Map<string, ArtifactVersion[]>): ArtifactIndex {
  const entries: ArtifactIndexEntry[] = [...byArtifact.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([artifactId, versions]) => {
      const sorted = sortArtifactVersions(versions);
      return {
        artifact_id: artifactId,
        versions: sorted,
        latest_version: sorted[sorted.length - 1]!
      };
    });

  return {
    schema_version: "v1",
    entries
  };
}

function ensureArtifactVersion(version: unknown): ArtifactVersion {
  if (typeof version !== "string" || !/^v\d+$/.test(version)) {
    throw new ArtifactIndexError("invalid_index", `Invalid artifact version: ${String(version)}`);
  }

  return version as ArtifactVersion;
}

function sortArtifactVersions(versions: ArtifactVersion[]): ArtifactVersion[] {
  return [...new Set(versions)].sort((left, right) => {
    return parseArtifactVersion(left) - parseArtifactVersion(right);
  });
}

function parseArtifactVersion(version: ArtifactVersion): number {
  const numeric = Number.parseInt(version.slice(1), 10);
  if (Number.isNaN(numeric)) {
    throw new ArtifactIndexError("invalid_index", `Invalid artifact version: ${version}`);
  }

  return numeric;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
