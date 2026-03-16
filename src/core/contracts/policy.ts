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

export type PolicyValidationReasonCode =
  | "invalid_policy_object"
  | "missing_coverage"
  | "invalid_coverage_scope"
  | "invalid_coverage_enforcement"
  | "missing_parallelism"
  | "invalid_parallelism_max_concurrent_tasks"
  | "invalid_parallelism_serialize_on_uncertainty"
  | "missing_gates"
  | "missing_enabled_gates"
  | "unknown_enabled_gate_key"
  | "missing_enabled_gate_key"
  | "invalid_enabled_gate_type"
  | "missing_applicable_project_modes"
  | "invalid_applicable_project_modes_shape"
  | "unknown_applicable_project_modes_gate"
  | "invalid_applicable_project_modes_type"
  | "invalid_project_mode";

export interface PolicyValidationIssue {
  path: string;
  message: string;
  reason_code: PolicyValidationReasonCode;
}

export interface PolicyValidationResult {
  valid: boolean;
  issues: PolicyValidationIssue[];
}

/**
 * Render a short, deterministic issue summary for CLI surfaces. The formatter
 * truncates after a few issues so diagnostics stay readable on one screen.
 */
export function formatPolicyValidationIssues(issues: PolicyValidationIssue[]): string {
  const maxIssuesToShow = 3;
  const displayedIssues = issues
    .slice(0, maxIssuesToShow)
    .map((issue) => `${issue.path} ${issue.message}`);
  const remainingCount = issues.length - displayedIssues.length;
  const baseMessage = displayedIssues.join("; ");

  if (remainingCount > 0) {
    return `${baseMessage}; ...and ${remainingCount} more`;
  }

  return baseMessage;
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

/**
 * Return the conservative bootstrap policy SpecForge assumes when no explicit
 * repo policy file overrides it.
 */
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

/**
 * Validate one policy object against the current v1 contract. The validator is
 * intentionally explicit instead of schema-library driven so reason codes and
 * messages stay stable across CLI, CI, and tests.
 */
export function validatePolicyConfig(candidate: unknown): PolicyValidationResult {
  const issues: PolicyValidationIssue[] = [];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {
      valid: false,
      issues: [
        {
          path: "$",
          message: "must be a JSON object.",
          reason_code: "invalid_policy_object"
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
      message: "must be an object with scope and enforcement.",
      reason_code: "missing_coverage"
    });
    return;
  }

  const coverage = candidate as Partial<CoveragePolicy>;
  if (coverage.scope !== "changed-lines") {
    issues.push({
      path: "coverage.scope",
      message: "must be \"changed-lines\".",
      reason_code: "invalid_coverage_scope"
    });
  }

  if (coverage.enforcement !== "report-only" && coverage.enforcement !== "hard-block") {
    issues.push({
      path: "coverage.enforcement",
      message: "must be \"report-only\" or \"hard-block\".",
      reason_code: "invalid_coverage_enforcement"
    });
  }
}

function validateParallelismPolicy(candidate: unknown, issues: PolicyValidationIssue[]): void {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    issues.push({
      path: "parallelism",
      message: "must be an object with max_concurrent_tasks and serialize_on_uncertainty.",
      reason_code: "missing_parallelism"
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
      message: "must be a positive integer.",
      reason_code: "invalid_parallelism_max_concurrent_tasks"
    });
  }

  if (typeof parallelism.serialize_on_uncertainty !== "boolean") {
    issues.push({
      path: "parallelism.serialize_on_uncertainty",
      message: "must be a boolean.",
      reason_code: "invalid_parallelism_serialize_on_uncertainty"
    });
  }
}

function validateGatePolicy(candidate: unknown, issues: PolicyValidationIssue[]): void {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    issues.push({
      path: "gates",
      message: "must be an object with enabled_by_default and applicable_project_modes.",
      reason_code: "missing_gates"
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
      message: "must be an object keyed by known gate names.",
      reason_code: "missing_enabled_gates"
    });
    return;
  }

  const enabledByDefault = candidate as Record<string, unknown>;
  // Report unknown keys first so typos are visible even when required known
  // gate keys are also missing from the same object.
  for (const gate of Object.keys(enabledByDefault)) {
    if (!isKnownGate(gate)) {
      issues.push({
        path: `gates.enabled_by_default.${gate}`,
        message: "must use a known artifact gate key.",
        reason_code: "unknown_enabled_gate_key"
      });
    }
  }

  for (const gate of ARTIFACT_GATES) {
    const value = enabledByDefault[gate];
    if (value === undefined) {
      issues.push({
        path: `gates.enabled_by_default.${gate}`,
        message: "is required and must be a boolean.",
        reason_code: "missing_enabled_gate_key"
      });
      continue;
    }

    if (typeof value !== "boolean") {
      issues.push({
        path: `gates.enabled_by_default.${gate}`,
        message: "must be a boolean.",
        reason_code: "invalid_enabled_gate_type"
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
      message: "must be an object keyed by gate name to arrays of supported project modes.",
      reason_code: "missing_applicable_project_modes"
    });
    return;
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    issues.push({
      path: "gates.applicable_project_modes",
      message: "must be an object keyed by gate name to arrays of supported project modes.",
      reason_code: "invalid_applicable_project_modes_shape"
    });
    return;
  }

  const allowedModesDescription = PROJECT_MODES.join(", ");
  const applicableProjectModes = candidate as Record<string, unknown>;
  for (const [gate, modes] of Object.entries(applicableProjectModes)) {
    if (!isKnownGate(gate)) {
      issues.push({
        path: `gates.applicable_project_modes.${gate}`,
        message: "must use a known artifact gate key.",
        reason_code: "unknown_applicable_project_modes_gate"
      });
      continue;
    }

    if (!Array.isArray(modes)) {
      issues.push({
        path: `gates.applicable_project_modes.${gate}`,
        message: "must be an array of supported project modes.",
        reason_code: "invalid_applicable_project_modes_type"
      });
      continue;
    }

    for (const [index, mode] of modes.entries()) {
      if (!PROJECT_MODES.includes(mode as ProjectMode)) {
        issues.push({
          path: `gates.applicable_project_modes.${gate}[${index}]`,
          message: `must be one of ${allowedModesDescription}.`,
          reason_code: "invalid_project_mode"
        });
      }
    }
  }
}
