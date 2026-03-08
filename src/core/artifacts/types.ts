export type ArtifactVersion = `v${number}`;

export interface ArtifactSourceRef {
  artifact_id: string;
  artifact_version: ArtifactVersion;
}

export interface ArtifactMetadata {
  artifact_id: string;
  artifact_version: ArtifactVersion;
  parent_version?: ArtifactVersion;
  created_timestamp: string;
  generator: string;
  source_refs: ArtifactSourceRef[];
  checksum: string;
}

