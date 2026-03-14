import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PR_VIEW_FIELDS = [
  "number",
  "url",
  "title",
  "state",
  "mergeStateStatus",
  "headRefName",
  "baseRefName",
  "statusCheckRollup",
  "closingIssuesReferences"
] as const;
const PR_CREATE_VIEW_FIELDS = [
  "number",
  "url",
  "headRefName",
  "baseRefName",
  "closingIssuesReferences"
] as const;

export type GitHubProviderErrorCode =
  | "provider_unavailable"
  | "invalid_repository"
  | "invalid_pull_request"
  | "command_failed"
  | "parse_failed";

export class GitHubProviderError extends Error {
  readonly code: GitHubProviderErrorCode;
  readonly details?: unknown;

  constructor(code: GitHubProviderErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "GitHubProviderError";
    this.code = code;
    this.details = details;
  }
}

export interface CreatePullRequestInput {
  repository: string;
  title: string;
  body: string;
  base_branch: string;
  head_branch: string;
  linked_issue_numbers?: number[];
  draft?: boolean;
}

export interface GitHubPullRequestRef {
  number: number;
  url: string;
  head_branch: string;
  base_branch: string;
  linked_issue_numbers: number[];
}

export type GitHubPullRequestState = "open" | "closed" | "merged";
export type GitHubMergeStateStatus =
  | "behind"
  | "blocked"
  | "clean"
  | "dirty"
  | "draft"
  | "has_hooks"
  | "unknown"
  | "unstable";
export type GitHubStatusCheckType = "check_run" | "status_context";
export type GitHubStatusCheckStatus = "completed" | "in_progress" | "pending" | "queued";
export type GitHubStatusCheckConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "pending"
  | "skipped"
  | "success"
  | "timed_out"
  | "unknown";
export type GitHubOverallStatus = "failure" | "no_checks" | "pending" | "success";

export interface GitHubStatusCheck {
  name: string;
  type: GitHubStatusCheckType;
  status: GitHubStatusCheckStatus;
  conclusion: GitHubStatusCheckConclusion;
  workflow_name?: string;
  details_url?: string;
}

export interface GitHubPullRequestStatus {
  number: number;
  url: string;
  title: string;
  state: GitHubPullRequestState;
  merge_state_status: GitHubMergeStateStatus;
  head_branch: string;
  base_branch: string;
  linked_issue_numbers: number[];
  overall_status: GitHubOverallStatus;
  status_checks: GitHubStatusCheck[];
}

export interface GetPullRequestStatusInput {
  repository?: string;
  pull_request: string;
}

export interface GitHubProvider {
  isAvailable(): Promise<boolean>;
  createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequestRef>;
  getPullRequestStatus(input: GetPullRequestStatusInput): Promise<GitHubPullRequestStatus>;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

type GitHubExec = (args: string[]) => Promise<ExecResult>;

export function createGitHubProvider(input: {
  gh_binary?: string;
  exec?: GitHubExec;
} = {}): GitHubProvider {
  const exec = input.exec ?? createGhExec(input.gh_binary ?? "gh");
  return new GhCliGitHubProvider(exec);
}

class GhCliGitHubProvider implements GitHubProvider {
  constructor(private readonly exec: GitHubExec) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.exec(["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequestRef> {
    ensureRepositorySlug(input.repository);
    ensureNonEmpty(input.title, "title");
    ensureNonEmpty(input.body, "body");
    ensureNonEmpty(input.base_branch, "base_branch");
    ensureNonEmpty(input.head_branch, "head_branch");

    const body = appendIssueLinks(input.body, input.linked_issue_numbers ?? []);
    const createArgs = [
      "pr",
      "create",
      "--repo",
      input.repository,
      "--base",
      input.base_branch,
      "--head",
      input.head_branch,
      "--title",
      input.title,
      "--body",
      body,
      ...(input.draft ? ["--draft"] : [])
    ];

    const created = await runGhCommand(this.exec, createArgs);
    const url = extractPullRequestUrl(created.stdout);
    const viewed = await runGhCommand(this.exec, [
      "pr",
      "view",
      url,
      "--repo",
      input.repository,
      "--json",
      PR_CREATE_VIEW_FIELDS.join(",")
    ]);
    const parsed = parseJson(viewed.stdout);

    return {
      number: readNumber(parsed.number, "pull request number"),
      url: readString(parsed.url, "pull request url"),
      head_branch: readString(parsed.headRefName, "head branch"),
      base_branch: readString(parsed.baseRefName, "base branch"),
      linked_issue_numbers: readLinkedIssueNumbers(parsed.closingIssuesReferences)
    };
  }

  async getPullRequestStatus(input: GetPullRequestStatusInput): Promise<GitHubPullRequestStatus> {
    if (!isPullRequestUrl(input.pull_request) && !input.repository) {
      throw new GitHubProviderError(
        "invalid_repository",
        "repository is required when pull_request is not a GitHub pull request URL."
      );
    }

    if (input.repository) {
      ensureRepositorySlug(input.repository);
    }

    ensureNonEmpty(input.pull_request, "pull_request");

    const viewed = await runGhCommand(this.exec, [
      "pr",
      "view",
      input.pull_request,
      ...(input.repository ? ["--repo", input.repository] : []),
      "--json",
      PR_VIEW_FIELDS.join(",")
    ]);
    const parsed = parseJson(viewed.stdout);
    const statusChecks = readStatusChecks(parsed.statusCheckRollup);

    return {
      number: readNumber(parsed.number, "pull request number"),
      url: readString(parsed.url, "pull request url"),
      title: readString(parsed.title, "pull request title"),
      state: normalizePullRequestState(parsed.state),
      merge_state_status: normalizeMergeStateStatus(parsed.mergeStateStatus),
      head_branch: readString(parsed.headRefName, "head branch"),
      base_branch: readString(parsed.baseRefName, "base branch"),
      linked_issue_numbers: readLinkedIssueNumbers(parsed.closingIssuesReferences),
      overall_status: deriveOverallStatus(statusChecks),
      status_checks: statusChecks
    };
  }
}

function createGhExec(ghBinary: string): GitHubExec {
  return async (args) => {
    try {
      const result = await execFileAsync(ghBinary, args, { encoding: "utf8" });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? ""
      };
    } catch (error) {
      const details = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (details.code === "ENOENT") {
        throw new GitHubProviderError(
          "provider_unavailable",
          `GitHub CLI was not found at ${ghBinary}.`,
          error
        );
      }

      throw new GitHubProviderError(
        "command_failed",
        `GitHub CLI command failed: ${[ghBinary, ...args].join(" ")}`,
        {
          message: details.message,
          stdout: details.stdout,
          stderr: details.stderr
        }
      );
    }
  };
}

async function runGhCommand(exec: GitHubExec, args: string[]): Promise<ExecResult> {
  return await exec(args);
}

function ensureRepositorySlug(repository: string): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository.trim())) {
    throw new GitHubProviderError(
      "invalid_repository",
      `repository must use OWNER/REPO format: ${repository}`
    );
  }
}

function ensureNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new GitHubProviderError("invalid_pull_request", `${field} must be non-empty.`);
  }
}

function appendIssueLinks(body: string, linkedIssueNumbers: number[]): string {
  if (linkedIssueNumbers.length === 0) {
    return body;
  }

  const lines = linkedIssueNumbers.map((issueNumber) => `Closes #${issueNumber}`);
  return `${body}\n\n${lines.join("\n")}`;
}

function extractPullRequestUrl(stdout: string): string {
  const url = stdout
    .split(/\s+/)
    .map((token) => token.trim())
    .find((token) => token.startsWith("https://github.com/") && token.includes("/pull/"));

  if (!url) {
    throw new GitHubProviderError(
      "parse_failed",
      "GitHub CLI did not return a pull request URL after creation."
    );
  }

  return url;
}

function parseJson(stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    throw new GitHubProviderError("parse_failed", "Failed to parse GitHub CLI JSON output.", error);
  }
}

function readNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new GitHubProviderError("parse_failed", `GitHub CLI returned invalid ${field}.`);
  }

  return value;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GitHubProviderError("parse_failed", `GitHub CLI returned invalid ${field}.`);
  }

  return value;
}

function readLinkedIssueNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (entry as { number?: unknown }).number)
    .filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry) && entry > 0)
    .sort((left, right) => left - right);
}

function readStatusChecks(value: unknown): GitHubStatusCheck[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => mapStatusCheck(entry))
    .filter((entry): entry is GitHubStatusCheck => entry !== undefined);
}

function mapStatusCheck(value: unknown): GitHubStatusCheck | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const entry = value as Record<string, unknown>;
  const typename = readOptionalString(entry.__typename);

  if (typename === "StatusContext") {
    const name = readOptionalString(entry.context);
    if (!name) {
      return undefined;
    }

    const conclusion = normalizeStatusContextConclusion(readOptionalString(entry.state));
    const detailsUrl = readOptionalString(entry.targetUrl);
    return {
      name,
      type: "status_context",
      status: conclusion === "pending" ? "pending" : "completed",
      conclusion,
      ...(detailsUrl ? { details_url: detailsUrl } : {})
    };
  }

  const name = readOptionalString(entry.name);
  if (!name) {
    return undefined;
  }

  const workflowName = readOptionalString(entry.workflowName);
  const detailsUrl = readOptionalString(entry.detailsUrl);

  return {
    name,
    type: "check_run",
    status: normalizeCheckStatus(readOptionalString(entry.status)),
    conclusion: normalizeCheckConclusion(
      readOptionalString(entry.conclusion),
      readOptionalString(entry.status)
    ),
    ...(workflowName ? { workflow_name: workflowName } : {}),
    ...(detailsUrl ? { details_url: detailsUrl } : {})
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizePullRequestState(value: unknown): GitHubPullRequestState {
  switch (readString(value, "pull request state").toLowerCase()) {
    case "open":
      return "open";
    case "closed":
      return "closed";
    case "merged":
      return "merged";
    default:
      throw new GitHubProviderError("parse_failed", "GitHub CLI returned an unknown pull request state.");
  }
}

function normalizeMergeStateStatus(value: unknown): GitHubMergeStateStatus {
  const normalized = readString(value, "merge state status").toLowerCase();
  switch (normalized) {
    case "behind":
    case "blocked":
    case "clean":
    case "dirty":
    case "draft":
    case "has_hooks":
    case "unknown":
    case "unstable":
      return normalized;
    default:
      return "unknown";
  }
}

function normalizeCheckStatus(value: string | undefined): GitHubStatusCheckStatus {
  switch ((value ?? "").toLowerCase()) {
    case "completed":
      return "completed";
    case "in_progress":
      return "in_progress";
    case "queued":
      return "queued";
    default:
      return "pending";
  }
}

function normalizeCheckConclusion(
  conclusion: string | undefined,
  status: string | undefined
): GitHubStatusCheckConclusion {
  if ((status ?? "").toLowerCase() !== "completed") {
    return "pending";
  }

  switch ((conclusion ?? "").toLowerCase()) {
    case "action_required":
    case "cancelled":
    case "failure":
    case "neutral":
    case "skipped":
    case "success":
    case "timed_out":
      return conclusion!.toLowerCase() as GitHubStatusCheckConclusion;
    default:
      return "unknown";
  }
}

function normalizeStatusContextConclusion(value: string | undefined): GitHubStatusCheckConclusion {
  switch ((value ?? "").toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "pending":
    case "expected":
      return "pending";
    default:
      return "unknown";
  }
}

function deriveOverallStatus(statusChecks: GitHubStatusCheck[]): GitHubOverallStatus {
  if (statusChecks.length === 0) {
    return "no_checks";
  }

  if (
    statusChecks.some((check) =>
      ["failure", "timed_out", "cancelled", "action_required", "unknown"].includes(
        check.conclusion
      )
    )
  ) {
    return "failure";
  }

  if (statusChecks.some((check) => check.conclusion === "pending" || check.status !== "completed")) {
    return "pending";
  }

  return "success";
}

function isPullRequestUrl(value: string): boolean {
  return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.test(value.trim());
}
