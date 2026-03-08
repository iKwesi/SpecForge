import type { ArtifactSourceRef, ArtifactVersion } from "../artifacts/types.js";
import type {
  PrdArtifactContract,
  SpecArtifactContract,
  ValidationIssue
} from "./contracts.js";
import {
  PRD_REQUIRED_SECTIONS,
  SPEC_REQUIRED_SECTIONS
} from "./contracts.js";
import { inferArtifactKindFromId, isOwnedArtifactKind } from "./ownership.js";

type SectionedArtifact = PrdArtifactContract | SpecArtifactContract;

type ArtifactVersionIndex = Record<string, ArtifactVersion>;

interface ValidateArtifactReferencesInput {
  artifactId: string;
  sourceRefs: ArtifactSourceRef[];
  artifactVersionIndex: ArtifactVersionIndex;
}

export function validateRequiredSections(artifact: SectionedArtifact): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (artifact.kind === "prd") {
    for (const sectionId of PRD_REQUIRED_SECTIONS) {
      const sectionBody = artifact.sections[sectionId];
      if (!sectionBody || sectionBody.trim().length === 0) {
        issues.push({
          code: "missing_required_section",
          artifact_id: artifact.metadata.artifact_id,
          section_id: sectionId,
          message: `Missing required section: ${sectionId}`
        });
      }
    }
  } else {
    for (const sectionId of SPEC_REQUIRED_SECTIONS) {
      const sectionBody = artifact.sections[sectionId];
      if (!sectionBody || sectionBody.trim().length === 0) {
        issues.push({
          code: "missing_required_section",
          artifact_id: artifact.metadata.artifact_id,
          section_id: sectionId,
          message: `Missing required section: ${sectionId}`
        });
      }
    }
  }

  return issues;
}

export function validateArtifactReferences(
  input: ValidateArtifactReferencesInput
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const reference of input.sourceRefs) {
    const inferredKind = inferArtifactKindFromId(reference.artifact_id);
    if (!inferredKind || !isOwnedArtifactKind(inferredKind)) {
      issues.push({
        code: "invalid_reference",
        artifact_id: input.artifactId,
        referenced_artifact_id: reference.artifact_id,
        message: `Unknown artifact kind for reference: ${reference.artifact_id}`
      });
      continue;
    }

    const indexedVersion = input.artifactVersionIndex[reference.artifact_id];
    if (!indexedVersion) {
      issues.push({
        code: "invalid_reference",
        artifact_id: input.artifactId,
        referenced_artifact_id: reference.artifact_id,
        message: `Missing referenced artifact in index: ${reference.artifact_id}`
      });
      continue;
    }

    if (indexedVersion !== reference.artifact_version) {
      issues.push({
        code: "version_mismatch",
        artifact_id: input.artifactId,
        referenced_artifact_id: reference.artifact_id,
        expected_version: indexedVersion,
        actual_version: reference.artifact_version,
        message:
          `Referenced artifact version mismatch for ${reference.artifact_id}: ` +
          `expected ${indexedVersion}, got ${reference.artifact_version}`
      });
    }
  }

  return issues;
}
