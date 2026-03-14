import type { SpecForgePolicyConfig } from "../contracts/policy.js";
import {
  evaluateBootstrapPolicyChecks,
  type PolicyEnforcementReasonCode
} from "../policy/enforcement.js";

export type CiPolicyStatus = "pass" | "fail";

export interface CiPolicyCheck {
  id: string;
  status: CiPolicyStatus;
  message: string;
  remediation?: string;
  reason_codes: PolicyEnforcementReasonCode[];
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
  const checks: CiPolicyCheck[] = evaluateBootstrapPolicyChecks(policy).map((check) => ({
    id: check.id,
    status: check.status,
    message: check.message,
    ...(check.remediation ? { remediation: check.remediation } : {}),
    reason_codes: check.reason_codes
  }));

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
