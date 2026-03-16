import { createHash } from "node:crypto";

import {
  type ArtifactMetadata,
  type ArtifactSourceRef,
  type ArtifactVersion
} from "./types.js";

interface CreateInitialArtifactMetadataInput {
  artifactId: string;
  generator: string;
  sourceRefs: ArtifactSourceRef[];
  content: string;
  createdTimestamp?: Date;
}

interface CreateNextArtifactMetadataInput {
  previous: ArtifactMetadata;
  generator: string;
  sourceRefs: ArtifactSourceRef[];
  content: string;
  createdTimestamp?: Date;
}

/**
 * Hash published artifact content so metadata can prove exactly which bytes a
 * given version was derived from.
 */
export function hashArtifactContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Derive the next semantic artifact version in the simple v<number> lineage
 * used throughout SpecForge.
 */
export function deriveArtifactVersion(previousVersion?: ArtifactVersion): ArtifactVersion {
  if (!previousVersion) {
    return "v1";
  }

  const match = /^v(\d+)$/.exec(previousVersion);
  if (!match || match[1] === undefined) {
    throw new Error(`Invalid artifact version format: ${previousVersion}`);
  }

  const next = Number.parseInt(match[1], 10) + 1;
  return `v${next}`;
}

/**
 * Create metadata for the first published version of an artifact. Initial
 * versions intentionally have no parent_version pointer.
 */
export function createInitialArtifactMetadata(
  input: CreateInitialArtifactMetadataInput
): ArtifactMetadata {
  return {
    artifact_id: input.artifactId,
    artifact_version: "v1",
    created_timestamp: (input.createdTimestamp ?? new Date()).toISOString(),
    generator: input.generator,
    source_refs: [...input.sourceRefs],
    checksum: hashArtifactContent(input.content)
  };
}

/**
 * Create metadata for a derived artifact version while preserving explicit
 * lineage back to the immediately previous published version.
 */
export function createNextArtifactMetadata(
  input: CreateNextArtifactMetadataInput
): ArtifactMetadata {
  return {
    artifact_id: input.previous.artifact_id,
    artifact_version: deriveArtifactVersion(input.previous.artifact_version),
    parent_version: input.previous.artifact_version,
    created_timestamp: (input.createdTimestamp ?? new Date()).toISOString(),
    generator: input.generator,
    source_refs: [...input.sourceRefs],
    checksum: hashArtifactContent(input.content)
  };
}
