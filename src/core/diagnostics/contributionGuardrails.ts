import type { ProjectMode } from "../contracts/domain.js";

export type ContributionGuardrailStatus = "pass" | "fail";
export type ContributionGuardrailCheckId =
  | "project_mode"
  | "branch_policy"
  | "path_boundary"
  | "minimal_diff";

export type ContributionGuardrailErrorCode = "invalid_mode" | "invalid_input";

export interface ContributionGuardrailCheck {
  id: ContributionGuardrailCheckId;
  status: ContributionGuardrailStatus;
  message: string;
  remediation?: string;
}

export interface ContributionGuardrailSummary {
  passed: number;
  failed: number;
}

export interface ContributionGuardrailResult {
  overall_status: ContributionGuardrailStatus;
  checks: ContributionGuardrailCheck[];
  summary: ContributionGuardrailSummary;
}

export interface RunContributionGuardrailCheckInput {
  project_mode: ProjectMode;
  branch_name: string;
  changed_files: string[];
  allowed_roots: string[];
  max_changed_files: number;
}

export class ContributionGuardrailError extends Error {
  readonly code: ContributionGuardrailErrorCode;
  readonly details?: unknown;

  constructor(code: ContributionGuardrailErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ContributionGuardrailError";
    this.code = code;
    this.details = details;
  }
}

const CONTRIBUTION_BRANCH_PREFIXES = ["contrib/", "fix/", "docs/"] as const;

/**
 * Evaluate contribution-mode safety constraints without mutating repository state.
 *
 * This v1 guardrail layer is intentionally narrow: it checks branch naming, changed-file
 * scope, and allowed path boundaries so contribution workflows fail closed before any
 * execution path can widen the blast radius.
 */
export function runContributionGuardrailCheck(
  input: RunContributionGuardrailCheckInput
) : ContributionGuardrailResult {
  if (input.project_mode !== "contribution") {
    throw new ContributionGuardrailError(
      "invalid_mode",
      "Contribution guardrails only apply to project_mode=contribution."
    );
  }

  const branchName = normalizeNonEmptyText(input.branch_name, "branch_name");
  const changedFiles = normalizePathList(input.changed_files, "changed_files");
  const allowedRoots = normalizePathList(input.allowed_roots, "allowed_roots");
  const maxChangedFiles = normalizePositiveInteger(input.max_changed_files, "max_changed_files");

  const checks: ContributionGuardrailCheck[] = [
    {
      id: "project_mode",
      status: "pass",
      message: "Contribution mode is active."
    },
    validateBranchPolicy(branchName),
    validatePathBoundaries(changedFiles, allowedRoots),
    validateMinimalDiff(changedFiles, maxChangedFiles)
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

export function formatContributionGuardrailReport(result: ContributionGuardrailResult): string {
  const lines = ["SpecForge Contribution Guardrails", ""];

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

function validateBranchPolicy(branchName: string): ContributionGuardrailCheck {
  const allowed = CONTRIBUTION_BRANCH_PREFIXES.some((prefix) => branchName.startsWith(prefix));

  if (!allowed) {
    return {
      id: "branch_policy",
      status: "fail",
      message: `Branch ${branchName} does not use an approved contribution prefix.`,
      remediation: `Use one of: ${CONTRIBUTION_BRANCH_PREFIXES.join(", ")}`
    };
  }

  return {
    id: "branch_policy",
    status: "pass",
    message: `Branch ${branchName} uses an approved contribution prefix.`
  };
}

function validatePathBoundaries(
  changedFiles: string[],
  allowedRoots: string[]
): ContributionGuardrailCheck {
  const disallowed = changedFiles.filter(
    (changedFile) => !allowedRoots.some((allowedRoot) => isWithinAllowedRoot(changedFile, allowedRoot))
  );

  if (disallowed.length > 0) {
    return {
      id: "path_boundary",
      status: "fail",
      message: `Changed files leave allowed contribution roots: ${disallowed.join(", ")}`,
      remediation: `Limit contribution diffs to: ${allowedRoots.join(", ")}`
    };
  }

  return {
    id: "path_boundary",
    status: "pass",
    message: `All changed files stay within allowed contribution roots (${allowedRoots.join(", ")}).`
  };
}

function validateMinimalDiff(
  changedFiles: string[],
  maxChangedFiles: number
): ContributionGuardrailCheck {
  if (changedFiles.length > maxChangedFiles) {
    return {
      id: "minimal_diff",
      status: "fail",
      message: `Changed file count ${changedFiles.length} exceeds minimal-diff budget ${maxChangedFiles}.`,
      remediation: "Reduce the contribution scope or split the work into smaller PRs."
    };
  }

  return {
    id: "minimal_diff",
    status: "pass",
    message: `Changed file count ${changedFiles.length} stays within minimal-diff budget ${maxChangedFiles}.`
  };
}

function normalizeNonEmptyText(value: string, fieldName: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new ContributionGuardrailError("invalid_input", `${fieldName} must be non-empty.`);
  }

  return normalized;
}

function normalizePathList(values: string[], fieldName: string): string[] {
  const normalized = values
    .map((value) => value.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((value) => value.length > 0);

  if (normalized.length === 0) {
    throw new ContributionGuardrailError("invalid_input", `${fieldName} must be non-empty.`);
  }

  return normalized;
}

function normalizePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ContributionGuardrailError(
      "invalid_input",
      `${fieldName} must be a positive integer.`
    );
  }

  return value;
}

function isWithinAllowedRoot(path: string, allowedRoot: string): boolean {
  return path === allowedRoot || path.startsWith(`${allowedRoot}/`);
}
