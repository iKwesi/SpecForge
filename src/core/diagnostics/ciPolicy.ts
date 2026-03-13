import { ARTIFACT_GATES, PROJECT_MODES } from "../contracts/domain.js";
import type { SpecForgePolicyConfig } from "../contracts/policy.js";

export type CiPolicyStatus = "pass" | "fail";

export interface CiPolicyCheck {
  id: string;
  status: CiPolicyStatus;
  message: string;
  remediation?: string;
}

export interface CiPolicyCheckSummary {
  passed: number;
  failed: number;
}

export interface CiPolicyCheckResult {
  overall_status: CiPolicyStatus;
  checks: CiPolicyCheck[];
  summary: CiPolicyCheckSummary;
}

/**
 * Validate the default engine policy against the bootstrap CI contract.
 *
 * CI should fail only when policy shape drifts from the supported v1 invariants,
 * not because the checker invents new enforcement rules beyond the current contract.
 */
export function runCiPolicyCheck(policy: SpecForgePolicyConfig): CiPolicyCheckResult {
  const checks: CiPolicyCheck[] = [
    validateCoveragePolicy(policy),
    validateParallelismPolicy(policy),
    validateGatePolicy(policy)
  ];

  const summary = {
    passed: checks.filter((check) => check.status === "pass").length,
    failed: checks.filter((check) => check.status === "fail").length
  };

  return {
    overall_status: summary.failed > 0 ? "fail" : "pass",
    checks,
    summary
  };
}

export function formatCiPolicyReport(result: CiPolicyCheckResult): string {
  const lines = ["SpecForge CI Policy Check", ""];

  for (const check of result.checks) {
    lines.push(`${check.status === "pass" ? "PASS" : "FAIL"} ${check.id} - ${check.message}`);
    if (check.remediation) {
      lines.push(`  Remediation: ${check.remediation}`);
    }
  }

  lines.push("");
  lines.push(`Summary: ${result.summary.passed} passed, ${result.summary.failed} failed`);
  lines.push(`Overall: ${result.overall_status.toUpperCase()}`);

  return `${lines.join("\n")}\n`;
}

function validateCoveragePolicy(policy: SpecForgePolicyConfig): CiPolicyCheck {
  const valid =
    policy.coverage.scope === "changed-lines" &&
    (policy.coverage.enforcement === "report-only" || policy.coverage.enforcement === "hard-block");

  if (!valid) {
    return {
      id: "coverage_policy",
      status: "fail",
      message: "Coverage policy must keep changed-lines scope with report-only or hard-block enforcement.",
      remediation: "Restore coverage.scope=changed-lines and a supported enforcement mode."
    };
  }

  return {
    id: "coverage_policy",
    status: "pass",
    message: `Coverage policy is ${policy.coverage.scope}/${policy.coverage.enforcement}.`
  };
}

function validateParallelismPolicy(policy: SpecForgePolicyConfig): CiPolicyCheck {
  const valid =
    Number.isInteger(policy.parallelism.max_concurrent_tasks) &&
    policy.parallelism.max_concurrent_tasks > 0 &&
    typeof policy.parallelism.serialize_on_uncertainty === "boolean";

  if (!valid) {
    return {
      id: "parallelism_policy",
      status: "fail",
      message: "Parallelism policy must define a positive max_concurrent_tasks and boolean serialize_on_uncertainty.",
      remediation: "Restore a valid parallelism policy shape before merging."
    };
  }

  return {
    id: "parallelism_policy",
    status: "pass",
    message: `Parallelism policy is max=${policy.parallelism.max_concurrent_tasks}, serialize_on_uncertainty=${policy.parallelism.serialize_on_uncertainty}.`
  };
}

function validateGatePolicy(policy: SpecForgePolicyConfig): CiPolicyCheck {
  const gateKeys = Object.keys(policy.gates.enabled_by_default);
  const enabledDefaultsValid =
    gateKeys.length === ARTIFACT_GATES.length &&
    ARTIFACT_GATES.every((gate) => typeof policy.gates.enabled_by_default[gate] === "boolean");

  const applicableModesValid = Object.values(policy.gates.applicable_project_modes).every((modes) =>
    (modes ?? []).every((mode) => PROJECT_MODES.includes(mode))
  );

  if (!enabledDefaultsValid || !applicableModesValid) {
    return {
      id: "gate_policy",
      status: "fail",
      message: "Gate policy must cover known gates and only reference supported project modes.",
      remediation: "Restore gate defaults and applicable project modes to the known v1 contract."
    };
  }

  return {
    id: "gate_policy",
    status: "pass",
    message: "Gate policy covers the known artifact gates and supported project modes."
  };
}
