import { ARTIFACT_GATES, PROJECT_MODES, type ArtifactGate, type ProjectMode } from "./domain.js";

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

export interface PolicyValidationIssue {
  path: string;
  message: string;
}

export interface PolicyValidationResult {
  valid: boolean;
  issues: PolicyValidationIssue[];
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

export function validatePolicyConfig(candidate: unknown): PolicyValidationResult {
  const issues: PolicyValidationIssue[] = [];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {
      valid: false,
      issues: [
        {
          path: "$",
          message: "must be a JSON object."
        }
      ]
    };
  }

  const config = candidate as Partial<SpecForgePolicyConfig> & Record<string, unknown>;
  validateCoveragePolicy(config.coverage, issues);
  validateParallelismPolicy(config.parallelism, issues);
  validateGatePolicy(config.gates, issues);

  return {
    valid: issues.length === 0,
    issues
  };
}

function validateCoveragePolicy(candidate: unknown, issues: PolicyValidationIssue[]): void {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    issues.push({
      path: "coverage",
      message: "must be an object with scope and enforcement."
    });
    return;
  }

  const coverage = candidate as Partial<CoveragePolicy>;
  if (coverage.scope !== "changed-lines") {
    issues.push({
      path: "coverage.scope",
      message: "must be \"changed-lines\"."
    });
  }

  if (coverage.enforcement !== "report-only" && coverage.enforcement !== "hard-block") {
    issues.push({
      path: "coverage.enforcement",
      message: "must be \"report-only\" or \"hard-block\"."
    });
  }
}

function validateParallelismPolicy(candidate: unknown, issues: PolicyValidationIssue[]): void {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    issues.push({
      path: "parallelism",
      message: "must be an object with max_concurrent_tasks and serialize_on_uncertainty."
    });
    return;
  }

  const parallelism = candidate as Partial<ParallelismPolicy>;
  if (
    !Number.isInteger(parallelism.max_concurrent_tasks) ||
    (parallelism.max_concurrent_tasks ?? 0) <= 0
  ) {
    issues.push({
      path: "parallelism.max_concurrent_tasks",
      message: "must be a positive integer."
    });
  }

  if (typeof parallelism.serialize_on_uncertainty !== "boolean") {
    issues.push({
      path: "parallelism.serialize_on_uncertainty",
      message: "must be a boolean."
    });
  }
}

function validateGatePolicy(candidate: unknown, issues: PolicyValidationIssue[]): void {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    issues.push({
      path: "gates",
      message: "must be an object with enabled_by_default and applicable_project_modes."
    });
    return;
  }

  const gates = candidate as Partial<GatePolicy>;
  validateEnabledGates(gates.enabled_by_default, issues);
  validateApplicableProjectModes(gates.applicable_project_modes, issues);
}

function validateEnabledGates(
  candidate: unknown,
  issues: PolicyValidationIssue[]
): void {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    issues.push({
      path: "gates.enabled_by_default",
      message: "must be an object keyed by known gate names."
    });
    return;
  }

  const enabledByDefault = candidate as Record<string, unknown>;
  for (const gate of Object.keys(enabledByDefault)) {
    if (!isKnownGate(gate)) {
      issues.push({
        path: `gates.enabled_by_default.${gate}`,
        message: "must use a known artifact gate key."
      });
    }
  }

  for (const gate of ARTIFACT_GATES) {
    if (typeof enabledByDefault[gate] !== "boolean") {
      issues.push({
        path: `gates.enabled_by_default.${gate}`,
        message: "must be a boolean."
      });
    }
  }
}

function validateApplicableProjectModes(
  candidate: unknown,
  issues: PolicyValidationIssue[]
): void {
  if (candidate === undefined) {
    issues.push({
      path: "gates.applicable_project_modes",
      message: "must be an object keyed by gate name to arrays of supported project modes."
    });
    return;
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    issues.push({
      path: "gates.applicable_project_modes",
      message: "must be an object keyed by gate name to arrays of supported project modes."
    });
    return;
  }

  const applicableProjectModes = candidate as Record<string, unknown>;
  for (const [gate, modes] of Object.entries(applicableProjectModes)) {
    if (!isKnownGate(gate)) {
      issues.push({
        path: `gates.applicable_project_modes.${gate}`,
        message: "must use a known artifact gate key."
      });
      continue;
    }

    if (!Array.isArray(modes)) {
      issues.push({
        path: `gates.applicable_project_modes.${gate}`,
        message: "must be an array of supported project modes."
      });
      continue;
    }

    for (const [index, mode] of modes.entries()) {
      if (!PROJECT_MODES.includes(mode as ProjectMode)) {
        issues.push({
          path: `gates.applicable_project_modes.${gate}[${index}]`,
          message: "must be one of greenfield, existing-repo, contribution, or feature-proposal."
        });
      }
    }
  }
}
