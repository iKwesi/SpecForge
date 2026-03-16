import {
  createGitHubProvider,
  type GetPullRequestStatusInput,
  type GitHubProvider,
  type GitHubPullRequestStatus
} from "../github/provider.js";
import {
  emitStatusNotification,
  type StatusNotificationDelivery,
  type StatusNotifier
} from "../notifiers/statusNotifiers.js";

export interface RunStatusInput extends GetPullRequestStatusInput {
  github_provider?: GitHubProvider;
  notifiers?: StatusNotifier[];
  emitted_at?: Date;
}

export interface StatusResult {
  pull_request: GitHubPullRequestStatus;
  notification_deliveries?: StatusNotificationDelivery[];
}

/**
 * Report the current GitHub pull request status using the configured provider.
 *
 * This stays intentionally narrow for v1: it reads pull request state and status
 * checks without trying to infer broader run orchestration from GitHub alone.
 */
export async function runStatus(input: RunStatusInput): Promise<StatusResult> {
  const provider = input.github_provider ?? createGitHubProvider();
  const pullRequest = await provider.getPullRequestStatus({
    pull_request: input.pull_request,
    ...(input.repository ? { repository: input.repository } : {})
  });
  const notificationDeliveries =
    input.notifiers && input.notifiers.length > 0
      ? await emitStatusNotification({
          pull_request: pullRequest,
          ...(input.repository ? { repository: input.repository } : {}),
          ...(input.emitted_at ? { emitted_at: input.emitted_at } : {}),
          notifiers: input.notifiers
        })
      : undefined;

  return {
    pull_request: pullRequest,
    ...(notificationDeliveries ? { notification_deliveries: notificationDeliveries } : {})
  };
}

export function formatStatusReport(result: StatusResult): string {
  const lines = [
    "SpecForge Status",
    "",
    `Pull Request: #${result.pull_request.number}`,
    `URL: ${result.pull_request.url}`,
    `Title: ${result.pull_request.title}`,
    `State: ${result.pull_request.state}`,
    `Merge State: ${result.pull_request.merge_state_status}`,
    `Overall Status: ${result.pull_request.overall_status}`,
    `Head Branch: ${result.pull_request.head_branch}`,
    `Base Branch: ${result.pull_request.base_branch}`,
    `Linked Issues: ${
      result.pull_request.linked_issue_numbers.length > 0
        ? result.pull_request.linked_issue_numbers.map((issueNumber) => `#${issueNumber}`).join(", ")
        : "none"
    }`,
    "",
    "Status Checks"
  ];

  if (result.pull_request.status_checks.length === 0) {
    lines.push("- none");
  } else {
    for (const statusCheck of result.pull_request.status_checks) {
      lines.push(
        `- ${statusCheck.name} [${statusCheck.type}] ${statusCheck.status}/${statusCheck.conclusion}`
      );
    }
  }

  if (result.notification_deliveries) {
    lines.push("", "Notifications");
    if (result.notification_deliveries.length === 0) {
      lines.push("- none");
    } else {
      for (const delivery of result.notification_deliveries) {
        lines.push(
          `- ${delivery.adapter_id} ${delivery.delivery_status}: ${delivery.message}`
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}
