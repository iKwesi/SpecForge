import type { ArtifactMetadata, ArtifactSourceRef } from "../artifacts/types.js";

export const PRD_REQUIRED_SECTIONS = [
  "outcome",
  "users_roles",
  "non_goals",
  "inputs",
  "outputs",
  "workflow",
  "interfaces",
  "quality_bar",
  "safety_compliance",
  "failure_modes",
  "evaluation",
  "operations"
] as const;

export type PrdSectionId = (typeof PRD_REQUIRED_SECTIONS)[number];

export const SPEC_REQUIRED_SECTIONS = [
  "summary",
  "scope",
  "contracts",
  "acceptance_criteria",
  "decisions",
  "work_graph"
] as const;

export type SpecSectionId = (typeof SPEC_REQUIRED_SECTIONS)[number];

interface SectionedArtifactContract<TSectionId extends string> {
  metadata: ArtifactMetadata;
  sections: Partial<Record<TSectionId, string>>;
  source_refs: ArtifactSourceRef[];
}

export interface PrdArtifactContract extends SectionedArtifactContract<PrdSectionId> {
  kind: "prd";
}

export interface SpecArtifactContract extends SectionedArtifactContract<SpecSectionId> {
  kind: "spec";
}

export type ValidationIssueCode =
  | "missing_required_section"
  | "invalid_reference"
  | "version_mismatch";

export interface ValidationIssue {
  code: ValidationIssueCode;
  artifact_id: string;
  message: string;
  section_id?: string;
  referenced_artifact_id?: string;
  expected_version?: string;
  actual_version?: string;
}

export interface ValidationReportArtifactContract {
  kind: "validation_report";
  metadata: ArtifactMetadata;
  target_artifact_id: string;
  passed: boolean;
  issues: ValidationIssue[];
}

export type SpecPhaseArtifactContract =
  | PrdArtifactContract
  | SpecArtifactContract
  | ValidationReportArtifactContract;

