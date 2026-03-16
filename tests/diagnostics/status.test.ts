import { describe, expect, it } from "vitest";

import { formatStatusReport, runStatus } from "../../src/core/diagnostics/status.js";

describe("runStatus", () => {
  it("renders a deterministic PR status report", async () => {
    const result = await runStatus({
      repository: "iKwesi/SpecForge",
      pull_request: "123",
      emitted_at: new Date("2026-03-16T00:10:00.000Z"),
      notifiers: [
        {
          adapter_id: "webhook",
          async notify(event) {
            expect(event).toEqual({
              event_kind: "pull_request_status",
              emitted_at: "2026-03-16T00:10:00.000Z",
              repository: "iKwesi/SpecForge",
              pull_request: {
                provider: "github",
                request_kind: "pull_request",
                number: 123,
                url: "https://github.com/iKwesi/SpecForge/pull/123",
                title: "feat: implement task flow",
                state: "open",
                merge_state_status: "clean",
                head_branch: "feat/task-1",
                base_branch: "main",
                linked_issue_numbers: [40],
                overall_status: "failure",
                status_checks: [
                  {
                    name: "build",
                    type: "check_run",
                    status: "completed",
                    conclusion: "success",
                    workflow_name: "ci",
                    details_url: "https://example.com/build"
                  },
                  {
                    name: "policy",
                    type: "check_run",
                    status: "completed",
                    conclusion: "failure",
                    workflow_name: "ci",
                    details_url: "https://example.com/policy"
                  }
                ]
              }
            });
          }
        }
      ],
      issue_tracker_provider: {
        name: "github",
        request_kind: "pull_request",
        async isAvailable() {
          return true;
        },
        async createPullRequest() {
          throw new Error("not used");
        },
        async getPullRequestStatus() {
          return {
            provider: "github",
            request_kind: "pull_request",
            number: 123,
            url: "https://github.com/iKwesi/SpecForge/pull/123",
            title: "feat: implement task flow",
            state: "open",
            merge_state_status: "clean",
            head_branch: "feat/task-1",
            base_branch: "main",
            linked_issue_numbers: [40],
            overall_status: "failure",
            status_checks: [
              {
                name: "build",
                type: "check_run",
                status: "completed",
                conclusion: "success",
                workflow_name: "ci",
                details_url: "https://example.com/build"
              },
              {
                name: "policy",
                type: "check_run",
                status: "completed",
                conclusion: "failure",
                workflow_name: "ci",
                details_url: "https://example.com/policy"
              }
            ]
          };
        }
      }
    });

    expect(result.pull_request.number).toBe(123);
    expect(result.pull_request.overall_status).toBe("failure");
    expect(result.notification_deliveries).toEqual([
      {
        adapter_id: "webhook",
        delivery_status: "delivered",
        message: "Status event delivered."
      }
    ]);

    const report = formatStatusReport(result);
    expect(report).toContain("SpecForge Status");
    expect(report).toContain("Provider: github");
    expect(report).toContain("Request Kind: pull_request");
    expect(report).toContain("Pull Request: #123");
    expect(report).toContain("Overall Status: failure");
    expect(report).toContain("Linked Issues: #40");
    expect(report).toContain("- policy [check_run] completed/failure");
    expect(report).toContain("Notifications");
    expect(report).toContain("- webhook delivered: Status event delivered.");
  });

  it("keeps status reporting successful when notifier delivery fails", async () => {
    const result = await runStatus({
      repository: "iKwesi/SpecForge",
      pull_request: "123",
      notifiers: [
        {
          adapter_id: "webhook",
          async notify() {
            throw new Error("webhook timed out");
          }
        }
      ],
      issue_tracker_provider: {
        name: "github",
        request_kind: "pull_request",
        async isAvailable() {
          return true;
        },
        async createPullRequest() {
          throw new Error("not used");
        },
        async getPullRequestStatus() {
          return {
            provider: "github",
            request_kind: "pull_request",
            number: 123,
            url: "https://github.com/iKwesi/SpecForge/pull/123",
            title: "feat: implement task flow",
            state: "open",
            merge_state_status: "clean",
            head_branch: "feat/task-1",
            base_branch: "main",
            linked_issue_numbers: [],
            overall_status: "success",
            status_checks: []
          };
        }
      }
    });

    expect(result.notification_deliveries).toEqual([
      {
        adapter_id: "webhook",
        delivery_status: "failed",
        message: "webhook timed out"
      }
    ]);
  });

  it("supports non-github issue tracker providers behind the shared status contract", async () => {
    const result = await runStatus({
      provider: "gitlab",
      repository: "gitlab-org/cli",
      pull_request: "42",
      issue_tracker_provider: {
        name: "gitlab",
        request_kind: "merge_request",
        async isAvailable() {
          return true;
        },
        async createPullRequest() {
          throw new Error("not used");
        },
        async getPullRequestStatus() {
          return {
            provider: "gitlab",
            request_kind: "merge_request",
            number: 42,
            url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/42",
            title: "feat: implement task flow",
            state: "open",
            merge_state_status: "clean",
            head_branch: "feat/task-1",
            base_branch: "main",
            linked_issue_numbers: [40],
            overall_status: "success",
            status_checks: [
              {
                name: "head_pipeline",
                type: "pipeline",
                status: "completed",
                conclusion: "success",
                details_url: "https://gitlab.com/gitlab-org/cli/-/pipelines/100"
              }
            ]
          };
        }
      }
    });

    expect(result.pull_request.provider).toBe("gitlab");
    expect(result.pull_request.request_kind).toBe("merge_request");

    const report = formatStatusReport(result);
    expect(report).toContain("Provider: gitlab");
    expect(report).toContain("Request Kind: merge_request");
    expect(report).toContain("- head_pipeline [pipeline] completed/success");
  });
});
