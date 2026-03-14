import { describe, expect, it } from "vitest";

import { formatStatusReport, runStatus } from "../../src/core/diagnostics/status.js";

describe("runStatus", () => {
  it("renders a deterministic PR status report", async () => {
    const result = await runStatus({
      repository: "iKwesi/SpecForge",
      pull_request: "123",
      github_provider: {
        async isAvailable() {
          return true;
        },
        async createPullRequest() {
          throw new Error("not used");
        },
        async getPullRequestStatus() {
          return {
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

    const report = formatStatusReport(result);
    expect(report).toContain("SpecForge Status");
    expect(report).toContain("Pull Request: #123");
    expect(report).toContain("Overall Status: failure");
    expect(report).toContain("Linked Issues: #40");
    expect(report).toContain("- policy [check_run] completed/failure");
  });
});
