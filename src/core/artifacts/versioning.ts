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

export function hashArtifactContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

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
