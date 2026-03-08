import { ARTIFACT_GATES, type ArtifactGate, type ProjectMode } from "./domain.js";

export type CoverageScope = "changed-lines";
export type CoverageEnforcementMode = "report-only" | "hard-block";

export interface CoveragePolicy {
  scope: CoverageScope;
  enforcement: CoverageEnforcementMode;
}

export interface ParallelismPolicy {
  max_concurrent_tasks: number;
  serialize_on_uncertainty: boolean;
}

export interface GatePolicy {
  enabled_by_default: Record<ArtifactGate, boolean>;
  applicable_project_modes: Partial<Record<ArtifactGate, ProjectMode[]>>;
}

export interface SpecForgePolicyConfig {
  coverage: CoveragePolicy;
  parallelism: ParallelismPolicy;
  gates: GatePolicy;
}

const DEFAULT_ENABLED_GATES: Record<ArtifactGate, boolean> = {
  proposal_approval: true,
  spec_approval: true,
  execution_start: false,
  merge_approval: true
};

const DEFAULT_APPLICABLE_MODES: Partial<Record<ArtifactGate, ProjectMode[]>> = {
  proposal_approval: ["feature-proposal"],
  spec_approval: ["greenfield", "existing-repo", "contribution", "feature-proposal"],
  execution_start: ["greenfield", "existing-repo", "contribution", "feature-proposal"],
  merge_approval: ["greenfield", "existing-repo", "contribution", "feature-proposal"]
};

export function createDefaultPolicyConfig(): SpecForgePolicyConfig {
  return {
    coverage: {
      scope: "changed-lines",
      enforcement: "report-only"
    },
    parallelism: {
      max_concurrent_tasks: 2,
      serialize_on_uncertainty: true
    },
    gates: {
      enabled_by_default: { ...DEFAULT_ENABLED_GATES },
      applicable_project_modes: { ...DEFAULT_APPLICABLE_MODES }
    }
  };
}

export function isKnownGate(gate: string): gate is ArtifactGate {
  return ARTIFACT_GATES.includes(gate as ArtifactGate);
}

