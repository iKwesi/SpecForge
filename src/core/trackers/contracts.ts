export const ISSUE_TRACKER_PROVIDER_NAMES = ["github", "gitlab"] as const;
export type IssueTrackerProviderName = (typeof ISSUE_TRACKER_PROVIDER_NAMES)[number];

export type IssueTrackerRequestKind = "pull_request" | "merge_request";
export type IssueTrackerPullRequestState = "open" | "closed" | "merged";
export type IssueTrackerMergeStateStatus =
  | "behind"
  | "blocked"
  | "clean"
  | "dirty"
  | "draft"
  | "has_hooks"
  | "unknown"
  | "unstable";
export type IssueTrackerStatusCheckType = "check_run" | "status_context" | "pipeline";
export type IssueTrackerStatusCheckStatus = "completed" | "in_progress" | "pending" | "queued";
export type IssueTrackerStatusCheckConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "pending"
  | "skipped"
  | "success"
  | "timed_out"
  | "unknown";
export type IssueTrackerOverallStatus = "failure" | "no_checks" | "pending" | "success";

export interface CreatePullRequestInput {
  repository: string;
  title: string;
  body: string;
  base_branch: string;
  head_branch: string;
  linked_issue_numbers?: number[];
  draft?: boolean;
}

export interface IssueTrackerPullRequestRef {
  number: number;
  url: string;
  head_branch: string;
  base_branch: string;
  linked_issue_numbers: number[];
}

export interface IssueTrackerStatusCheck {
  name: string;
  type: IssueTrackerStatusCheckType;
  status: IssueTrackerStatusCheckStatus;
  conclusion: IssueTrackerStatusCheckConclusion;
  workflow_name?: string;
  details_url?: string;
}

export interface IssueTrackerPullRequestStatus {
  provider: IssueTrackerProviderName;
  request_kind: IssueTrackerRequestKind;
  number: number;
  url: string;
  title: string;
  state: IssueTrackerPullRequestState;
  merge_state_status: IssueTrackerMergeStateStatus;
  head_branch: string;
  base_branch: string;
  linked_issue_numbers: number[];
  overall_status: IssueTrackerOverallStatus;
  status_checks: IssueTrackerStatusCheck[];
}

export interface GetPullRequestStatusInput {
  repository?: string;
  pull_request: string;
}

export interface IssueTrackerProvider {
  name: IssueTrackerProviderName;
  request_kind: IssueTrackerRequestKind;
  isAvailable(): Promise<boolean>;
  createPullRequest(input: CreatePullRequestInput): Promise<IssueTrackerPullRequestRef>;
  getPullRequestStatus(input: GetPullRequestStatusInput): Promise<IssueTrackerPullRequestStatus>;
}

export function deriveOverallStatus(
  statusChecks: IssueTrackerStatusCheck[]
): IssueTrackerOverallStatus {
  if (statusChecks.length === 0) {
    return "no_checks";
  }

  if (
    statusChecks.some((check) =>
      ["action_required", "cancelled", "failure", "timed_out", "unknown"].includes(check.conclusion)
    )
  ) {
    return "failure";
  }

  if (statusChecks.some((check) => check.conclusion === "pending" || check.status !== "completed")) {
    return "pending";
  }

  return "success";
}
