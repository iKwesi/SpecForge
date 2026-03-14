import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  createDefaultPolicyConfig,
  validatePolicyConfig,
  type SpecForgePolicyConfig
} from "../contracts/policy.js";

const execFileAsync = promisify(execFile);
const MINIMUM_NODE_MAJOR = 22;

export type DoctorStatus = "pass" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  remediation?: string;
}

export interface DoctorSummary {
  passed: number;
  failed: number;
}

export interface DoctorResult {
  overall_status: DoctorStatus;
  checks: DoctorCheck[];
  summary: DoctorSummary;
}

export interface DoctorCommandResult {
  stdout: string;
  stderr: string;
}

export type DoctorCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string }
) => Promise<DoctorCommandResult>;

export interface RunDoctorInput {
  cwd?: string;
  node_version?: string;
  policy?: SpecForgePolicyConfig;
  command_runner?: DoctorCommandRunner;
}

/**
 * Run deterministic environment and policy checks for local execution readiness.
 *
 * The doctor command stays intentionally bounded in v1: it validates the runtime,
 * required tooling, repository presence, and policy shape without mutating repo state.
 */
export async function runDoctor(input: RunDoctorInput = {}): Promise<DoctorResult> {
  const cwd = input.cwd ?? process.cwd();
  const nodeVersion = input.node_version ?? process.version;
  const policy = input.policy ?? createDefaultPolicyConfig();
  const commandRunner = input.command_runner ?? defaultCommandRunner;
  const checks: DoctorCheck[] = [];

  checks.push(checkNodeVersion(nodeVersion));

  const gitCheck = await checkBinary({
    id: "git_binary",
    label: "Git binary",
    command: "git",
    args: ["--version"],
    remediation: "Install git and ensure it is available on PATH.",
    command_runner: commandRunner
  });
  checks.push(gitCheck);

  const pnpmCheck = await checkBinary({
    id: "pnpm_binary",
    label: "pnpm package manager",
    command: "pnpm",
    args: ["--version"],
    remediation: "Install pnpm and ensure it is available on PATH.",
    command_runner: commandRunner
  });
  checks.push(pnpmCheck);

  checks.push(await checkRepositoryRoot({ cwd, git_check: gitCheck, command_runner: commandRunner }));
  checks.push(checkPolicyConfig(policy));

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

export function formatDoctorReport(result: DoctorResult): string {
  const lines = ["SpecForge Doctor", ""];

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

function checkNodeVersion(nodeVersion: string): DoctorCheck {
  const match = /^v(\d+)(?:\.\d+){0,2}$/.exec(nodeVersion.trim());
  const major = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;

  if (!Number.isFinite(major) || major < MINIMUM_NODE_MAJOR) {
    return {
      id: "node_version",
      label: "Node.js runtime",
      status: "fail",
      message: `Detected ${nodeVersion}, but SpecForge requires Node.js ${MINIMUM_NODE_MAJOR} LTS or newer.`,
      remediation: `Install Node.js ${MINIMUM_NODE_MAJOR} LTS or newer and re-run sf doctor.`
    };
  }

  return {
    id: "node_version",
    label: "Node.js runtime",
    status: "pass",
    message: `Node.js ${nodeVersion.replace(/^v/, "")} satisfies the minimum runtime requirement.`
  };
}

async function checkBinary(input: {
  id: string;
  label: string;
  command: string;
  args: string[];
  remediation: string;
  command_runner: DoctorCommandRunner;
}): Promise<DoctorCheck> {
  try {
    const result = await input.command_runner(input.command, input.args);
    const version = result.stdout.trim() || result.stderr.trim() || "available";

    return {
      id: input.id,
      label: input.label,
      status: "pass",
      message: `${input.label} detected: ${version}.`
    };
  } catch {
    return {
      id: input.id,
      label: input.label,
      status: "fail",
      message: `${input.label} was not found on PATH.`,
      remediation: input.remediation
    };
  }
}

async function checkRepositoryRoot(input: {
  cwd: string;
  git_check: DoctorCheck;
  command_runner: DoctorCommandRunner;
}): Promise<DoctorCheck> {
  if (input.git_check.status === "fail") {
    return {
      id: "repository_root",
      label: "Repository root",
      status: "fail",
      message: "Repository readiness could not be validated because git is unavailable.",
      remediation: "Initialize or open a git repository before running execution commands."
    };
  }

  try {
    const result = await input.command_runner("git", ["rev-parse", "--show-toplevel"], {
      cwd: input.cwd
    });
    const repoRoot = result.stdout.trim();

    if (repoRoot.length === 0) {
      throw new Error("empty repo root");
    }

    return {
      id: "repository_root",
      label: "Repository root",
      status: "pass",
      message: `Git repository detected at ${repoRoot}.`
    };
  } catch {
    return {
      id: "repository_root",
      label: "Repository root",
      status: "fail",
      message: "Current working directory is not inside a git repository.",
      remediation: "Initialize or open a git repository before running execution commands."
    };
  }
}

function checkPolicyConfig(policy: SpecForgePolicyConfig): DoctorCheck {
  const validation = validatePolicyConfig(policy);
  if (!validation.valid) {
    const issueSummary = formatPolicyValidationIssues(validation.issues);

    return {
      id: "policy_config",
      label: "Policy config",
      status: "fail",
      message: `Policy configuration is invalid: ${issueSummary}`,
      remediation:
        "Update the policy config to match docs/POLICY_CONFIG.md or docs/examples/specforge.policy.example.json."
    };
  }

  return {
    id: "policy_config",
    label: "Policy config",
    status: "pass",
    message: "Policy configuration is valid for the current v1 contract."
  };
}

function formatPolicyValidationIssues(
  issues: Array<{ path: string; message: string }>
): string {
  const maxIssuesToShow = 3;
  const displayedIssues = issues
    .slice(0, maxIssuesToShow)
    .map((issue) => `${issue.path} ${issue.message}`);
  const remainingCount = issues.length - displayedIssues.length;
  const baseMessage = displayedIssues.join("; ");

  if (remainingCount > 0) {
    return `${baseMessage}; ${remainingCount} additional issue${remainingCount === 1 ? "" : "s"} not shown.`;
  }

  return baseMessage;
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  options?: { cwd?: string }
): Promise<DoctorCommandResult> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    ...(options?.cwd ? { cwd: options.cwd } : {})
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr ?? ""
  };
}
