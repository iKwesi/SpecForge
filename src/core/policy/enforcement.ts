import {
  formatPolicyValidationIssues,
  validatePolicyConfig,
  type PolicyValidationIssue,
  type PolicyValidationReasonCode
} from "../contracts/policy.js";

export type PolicyEnforcementCheckId =
  | "policy_config"
  | "coverage_policy"
  | "parallelism_policy"
  | "gate_policy";

export type PolicyEnforcementStatus = "pass" | "fail";

export type PolicyEnforcementReasonCode =
  | PolicyValidationReasonCode
  | "policy_config_valid"
  | "coverage_supported"
  | "parallelism_supported"
  | "gate_policy_supported";

export interface PolicyEnforcementCheck {
  id: PolicyEnforcementCheckId;
  status: PolicyEnforcementStatus;
  message: string;
  remediation?: string;
  reason_codes: PolicyEnforcementReasonCode[];
  issues?: PolicyValidationIssue[];
}

const GLOBAL_POLICY_REASON_CODES = new Set<PolicyValidationReasonCode>(["invalid_policy_object"]);
const COVERAGE_REASON_CODES = new Set<PolicyValidationReasonCode>([
  "missing_coverage",
  "invalid_coverage_scope",
  "invalid_coverage_enforcement"
]);
const PARALLELISM_REASON_CODES = new Set<PolicyValidationReasonCode>([
  "missing_parallelism",
  "invalid_parallelism_max_concurrent_tasks",
  "invalid_parallelism_serialize_on_uncertainty"
]);
const GATE_REASON_CODES = new Set<PolicyValidationReasonCode>([
  "missing_gates",
  "missing_enabled_gates",
  "unknown_enabled_gate_key",
  "missing_enabled_gate_key",
  "invalid_enabled_gate_type",
  "missing_applicable_project_modes",
  "invalid_applicable_project_modes_shape",
  "unknown_applicable_project_modes_gate",
  "invalid_applicable_project_modes_type",
  "invalid_project_mode"
]);

/**
 * Evaluate the full policy config contract once and return a deterministic
 * result that downstream diagnostics can reuse without re-encoding rules.
 */
export function evaluatePolicyConfigCheck(policy: unknown): PolicyEnforcementCheck {
  const validation = validatePolicyConfig(policy);
  if (!validation.valid) {
    return {
      id: "policy_config",
      status: "fail",
      message: `Policy configuration is invalid: ${formatPolicyValidationIssues(validation.issues)}`,
      remediation:
        "Update the policy config to match docs/POLICY_CONFIG.md or docs/examples/specforge.policy.example.json.",
      reason_codes: collectIssueReasonCodes(validation.issues),
      issues: validation.issues
    };
  }

  return {
    id: "policy_config",
    status: "pass",
    message: "Policy configuration is valid for the current v1 contract.",
    reason_codes: ["policy_config_valid"]
  };
}

/**
 * Evaluate the narrow bootstrap policy invariants used by CI and other
 * safety gates. These checks stay intentionally scoped to the current v1
 * support contract instead of inventing broader policy semantics.
 */
export function evaluateBootstrapPolicyChecks(policy: unknown): PolicyEnforcementCheck[] {
  const validation = validatePolicyConfig(policy);

  return [
    buildCoverageCheck(policy, validation.issues),
    buildParallelismCheck(policy, validation.issues),
    buildGateCheck(validation.issues)
  ];
}

function buildCoverageCheck(policy: unknown, issues: PolicyValidationIssue[]): PolicyEnforcementCheck {
  const relevantIssues = selectIssues(issues, COVERAGE_REASON_CODES);
  if (relevantIssues.length > 0) {
    return {
      id: "coverage_policy",
      status: "fail",
      message: "Coverage policy must keep changed-lines scope with report-only or hard-block enforcement.",
      remediation: "Restore coverage.scope=changed-lines and a supported enforcement mode.",
      reason_codes: collectIssueReasonCodes(relevantIssues),
      issues: relevantIssues
    };
  }

  const coverageDescription = describeCoveragePolicy(policy);
  return {
    id: "coverage_policy",
    status: "pass",
    message: `Coverage policy is ${coverageDescription}.`,
    reason_codes: ["coverage_supported"]
  };
}

function buildParallelismCheck(
  policy: unknown,
  issues: PolicyValidationIssue[]
): PolicyEnforcementCheck {
  const relevantIssues = selectIssues(issues, PARALLELISM_REASON_CODES);
  if (relevantIssues.length > 0) {
    return {
      id: "parallelism_policy",
      status: "fail",
      message: "Parallelism policy must define a positive max_concurrent_tasks and boolean serialize_on_uncertainty.",
      remediation: "Restore a valid parallelism policy shape before merging.",
      reason_codes: collectIssueReasonCodes(relevantIssues),
      issues: relevantIssues
    };
  }

  const parallelismDescription = describeParallelismPolicy(policy);
  return {
    id: "parallelism_policy",
    status: "pass",
    message: `Parallelism policy is ${parallelismDescription}.`,
    reason_codes: ["parallelism_supported"]
  };
}

function buildGateCheck(issues: PolicyValidationIssue[]): PolicyEnforcementCheck {
  const relevantIssues = selectIssues(issues, GATE_REASON_CODES);
  if (relevantIssues.length > 0) {
    return {
      id: "gate_policy",
      status: "fail",
      message: "Gate policy must cover known gates and only reference supported project modes.",
      remediation: "Restore gate defaults and applicable project modes to the known v1 contract.",
      reason_codes: collectIssueReasonCodes(relevantIssues),
      issues: relevantIssues
    };
  }

  return {
    id: "gate_policy",
    status: "pass",
    message: "Gate policy covers the known artifact gates and supported project modes.",
    reason_codes: ["gate_policy_supported"]
  };
}

function selectIssues(
  issues: PolicyValidationIssue[],
  allowedReasonCodes: ReadonlySet<PolicyValidationReasonCode>
): PolicyValidationIssue[] {
  return issues.filter(
    (issue) =>
      GLOBAL_POLICY_REASON_CODES.has(issue.reason_code) || allowedReasonCodes.has(issue.reason_code)
  );
}

function collectIssueReasonCodes(
  issues: PolicyValidationIssue[]
): PolicyEnforcementReasonCode[] {
  return [...new Set(issues.map((issue) => issue.reason_code))];
}

function describeCoveragePolicy(policy: unknown): string {
  const candidate = policy as {
    coverage?: {
      scope?: unknown;
      enforcement?: unknown;
    };
  };

  return `${String(candidate.coverage?.scope)}/${String(candidate.coverage?.enforcement)}`;
}

function describeParallelismPolicy(policy: unknown): string {
  const candidate = policy as {
    parallelism?: {
      max_concurrent_tasks?: unknown;
      serialize_on_uncertainty?: unknown;
    };
  };

  return `max=${String(candidate.parallelism?.max_concurrent_tasks)}, serialize_on_uncertainty=${String(candidate.parallelism?.serialize_on_uncertainty)}`;
}
