import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  deriveOverallStatus,
  type CreatePullRequestInput,
  type GetPullRequestStatusInput,
  type IssueTrackerProvider,
  type IssueTrackerPullRequestRef,
  type IssueTrackerPullRequestState,
  type IssueTrackerPullRequestStatus,
  type IssueTrackerStatusCheck,
  type IssueTrackerStatusCheckConclusion,
  type IssueTrackerStatusCheckStatus
} from "../trackers/contracts.js";

const execFileAsync = promisify(execFile);

const GITLAB_MERGE_REQUEST_PATH_PATTERN = /^\/(.+)\/-\/merge_requests\/(\d+)(?:\/.*)?$/;

export type GitLabProviderErrorCode =
  | "provider_unavailable"
  | "invalid_repository"
  | "invalid_pull_request"
  | "command_failed"
  | "parse_failed";

export class GitLabProviderError extends Error {
  readonly code: GitLabProviderErrorCode;
  readonly details?: unknown;

  constructor(code: GitLabProviderErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "GitLabProviderError";
    this.code = code;
    this.details = details;
  }
}

export type GitLabProvider = IssueTrackerProvider;

interface ExecResult {
  stdout: string;
  stderr: string;
}

type GitLabExec = (args: string[]) => Promise<ExecResult>;

export function createGitLabProvider(input: {
  glab_binary?: string;
  exec?: GitLabExec;
} = {}): GitLabProvider {
  const exec = input.exec ?? createGlabExec(input.glab_binary ?? "glab");

  return {
    name: "gitlab",
    request_kind: "merge_request",
    async isAvailable() {
      try {
        await exec(["--version"]);
        return true;
      } catch {
        return false;
      }
    },
    async createPullRequest(input: CreatePullRequestInput): Promise<IssueTrackerPullRequestRef> {
      ensureGitLabProjectPath(input.repository);
      ensureNonEmpty(input.title, "title");
      ensureNonEmpty(input.body, "body");
      ensureNonEmpty(input.base_branch, "base_branch");
      ensureNonEmpty(input.head_branch, "head_branch");

      const description = appendIssueLinks(input.body, input.linked_issue_numbers ?? []);
      const created = await runGlabCommand(exec, [
        "api",
        `projects/${encodeURIComponent(input.repository)}/merge_requests`,
        "--method",
        "POST",
        "--field",
        `source_branch=${input.head_branch}`,
        "--field",
        `target_branch=${input.base_branch}`,
        "--field",
        `title=${input.draft ? prefixDraftTitle(input.title) : input.title}`,
        "--field",
        `description=${description}`
      ]);
      const parsed = parseJson(created.stdout);

      return {
        number: readNumber(parsed.iid, "merge request iid"),
        url: readString(parsed.web_url, "merge request url"),
        head_branch: readString(parsed.source_branch, "head branch"),
        base_branch: readString(parsed.target_branch, "base branch"),
        linked_issue_numbers: extractLinkedIssueNumbers(
          normalizeOptionalBody(parsed.description) ?? description
        )
      };
    },
    async getPullRequestStatus(
      input: GetPullRequestStatusInput
    ): Promise<IssueTrackerPullRequestStatus> {
      const parsedMergeRequestUrl = parseGitLabMergeRequestUrl(input.pull_request);
      const repository = input.repository ?? parsedMergeRequestUrl?.repository;
      const mergeRequestIid = normalizeMergeRequestIid(parsedMergeRequestUrl?.iid ?? input.pull_request);

      if (!repository) {
        throw new GitLabProviderError(
          "invalid_repository",
          "repository is required when pull_request is not a GitLab merge request URL."
        );
      }

      ensureGitLabProjectPath(repository);

      const viewed = await runGlabCommand(exec, [
        "api",
        `projects/${encodeURIComponent(repository)}/merge_requests/${mergeRequestIid}`
      ]);
      const parsed = parseJson(viewed.stdout);
      const statusChecks = readStatusChecks(parsed.head_pipeline);

      return {
        provider: "gitlab",
        request_kind: "merge_request",
        number: readNumber(parsed.iid, "merge request iid"),
        url: readString(parsed.web_url, "merge request url"),
        title: readString(parsed.title, "merge request title"),
        state: normalizePullRequestState(parsed.state),
        merge_state_status: normalizeMergeStateStatus(
          readOptionalString(parsed.detailed_merge_status),
          readOptionalBoolean(parsed.draft) ?? false
        ),
        head_branch: readString(parsed.source_branch, "head branch"),
        base_branch: readString(parsed.target_branch, "base branch"),
        linked_issue_numbers: extractLinkedIssueNumbers(readOptionalString(parsed.description) ?? ""),
        overall_status: deriveOverallStatus(statusChecks),
        status_checks: statusChecks
      };
    }
  };
}

function createGlabExec(glabBinary: string): GitLabExec {
  return async (args) => {
    try {
      const result = await execFileAsync(glabBinary, args, { encoding: "utf8" });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? ""
      };
    } catch (error) {
      const details = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (details.code === "ENOENT") {
        throw new GitLabProviderError(
          "provider_unavailable",
          `GitLab CLI was not found at ${glabBinary}.`,
          error
        );
      }

      throw new GitLabProviderError(
        "command_failed",
        `GitLab CLI command failed: ${[glabBinary, ...args].join(" ")}`,
        {
          message: details.message,
          stdout: details.stdout,
          stderr: details.stderr
        }
      );
    }
  };
}

async function runGlabCommand(exec: GitLabExec, args: string[]): Promise<ExecResult> {
  return exec(args);
}

function ensureGitLabProjectPath(value: string): void {
  ensureNonEmpty(value, "repository", "invalid_repository");
  const segments = value.split("/");
  if (segments.length < 2 || segments.some((segment) => segment.trim().length === 0)) {
    throw new GitLabProviderError(
      "invalid_repository",
      "repository must be a GitLab project path like group/project."
    );
  }
}

function ensureNonEmpty(
  value: string | undefined,
  field: string,
  code: GitLabProviderErrorCode = "invalid_pull_request"
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GitLabProviderError(code, `${field} must be non-empty.`);
  }
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isPlainRecord(parsed)) {
      throw new Error("expected JSON object");
    }
    return parsed;
  } catch (error) {
    throw new GitLabProviderError("parse_failed", "Failed to parse GitLab CLI JSON output.", error);
  }
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GitLabProviderError("parse_failed", `GitLab CLI returned invalid ${field}.`);
  }

  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new GitLabProviderError("parse_failed", `GitLab CLI returned invalid ${field}.`);
  }

  return value;
}

function normalizePullRequestState(value: unknown): IssueTrackerPullRequestState {
  const normalized = readString(value, "merge request state").toLowerCase();
  switch (normalized) {
    case "opened":
      return "open";
    case "closed":
    case "locked":
      return "closed";
    case "merged":
      return "merged";
    default:
      throw new GitLabProviderError(
        "parse_failed",
        "GitLab CLI returned an unknown merge request state."
      );
  }
}

function normalizeMergeStateStatus(
  value: string | undefined,
  draft: boolean
): IssueTrackerPullRequestStatus["merge_state_status"] {
  if (draft) {
    return "draft";
  }

  switch ((value ?? "").toLowerCase()) {
    case "mergeable":
    case "can_be_merged":
      return "clean";
    case "need_rebase":
      return "behind";
    case "conflict":
    case "conflicts":
    case "cannot_be_merged":
      return "dirty";
    case "ci_must_pass":
    case "discussions_not_resolved":
      return "blocked";
    case "checking":
      return "unstable";
    default:
      return "unknown";
  }
}

function readStatusChecks(value: unknown): IssueTrackerStatusCheck[] {
  if (!isPlainRecord(value)) {
    return [];
  }

  const pipelineStatus = normalizePipelineStatus(readOptionalString(value.status));
  if (!pipelineStatus) {
    return [];
  }

  const detailsUrl = readOptionalString(value.web_url);
  return [
    {
      name: readOptionalString(value.name) ?? "head_pipeline",
      type: "pipeline",
      status: pipelineStatus.status,
      conclusion: pipelineStatus.conclusion,
      ...(detailsUrl ? { details_url: detailsUrl } : {})
    }
  ];
}

function normalizePipelineStatus(value: string | undefined): {
  status: IssueTrackerStatusCheckStatus;
  conclusion: IssueTrackerStatusCheckConclusion;
} | undefined {
  switch ((value ?? "").toLowerCase()) {
    case "success":
      return { status: "completed", conclusion: "success" };
    case "failed":
      return { status: "completed", conclusion: "failure" };
    case "canceled":
    case "cancelled":
      return { status: "completed", conclusion: "cancelled" };
    case "skipped":
      return { status: "completed", conclusion: "skipped" };
    case "manual":
      return { status: "completed", conclusion: "action_required" };
    case "running":
      return { status: "in_progress", conclusion: "pending" };
    case "created":
    case "pending":
    case "preparing":
    case "waiting_for_resource":
      return { status: "pending", conclusion: "pending" };
    case "scheduled":
      return { status: "queued", conclusion: "pending" };
    default:
      return undefined;
  }
}

function appendIssueLinks(body: string, linkedIssueNumbers: number[]): string {
  if (linkedIssueNumbers.length === 0) {
    return body;
  }

  const linkage = linkedIssueNumbers.map((issueNumber) => `Closes #${issueNumber}`).join("\n");
  return `${body}\n\n${linkage}`;
}

function prefixDraftTitle(title: string): string {
  return /^draft:/i.test(title) ? title : `Draft: ${title}`;
}

function extractLinkedIssueNumbers(body: string): number[] {
  const matches = body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi);
  const linkedIssueNumbers = new Set<number>();
  for (const match of matches) {
    linkedIssueNumbers.add(Number(match[1]));
  }

  return [...linkedIssueNumbers].sort((left, right) => left - right);
}

function parseGitLabMergeRequestUrl(
  value: string
): { repository: string; iid: string } | undefined {
  try {
    const url = new URL(value);
    const match = url.pathname.match(GITLAB_MERGE_REQUEST_PATH_PATTERN);
    if (!match) {
      return undefined;
    }

    const repository = match[1];
    const iid = match[2];
    if (!repository || !iid) {
      return undefined;
    }

    return {
      repository: decodeURIComponent(repository),
      iid
    };
  } catch {
    return undefined;
  }
}

function normalizeOptionalBody(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.trim().length > 0 ? value : undefined;
}

function normalizeMergeRequestIid(value: string): string {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new GitLabProviderError(
      "invalid_pull_request",
      "pull_request must be a positive merge request number or a GitLab merge request URL."
    );
  }

  return trimmed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
