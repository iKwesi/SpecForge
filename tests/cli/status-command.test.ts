import { describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import type { StatusResult } from "../../src/core/diagnostics/status.js";

function buildStatusResult(): StatusResult {
  return {
    pull_request: {
      number: 123,
      url: "https://github.com/iKwesi/SpecForge/pull/123",
      title: "feat: implement task flow",
      state: "open",
      merge_state_status: "clean",
      head_branch: "feat/task-1",
      base_branch: "main",
      linked_issue_numbers: [40],
      overall_status: "success",
      status_checks: [
        {
          name: "build",
          type: "check_run",
          status: "completed",
          conclusion: "success",
          workflow_name: "ci",
          details_url: "https://example.com/build"
        }
      ]
    },
    notification_deliveries: [
      {
        adapter_id: "webhook",
        delivery_status: "delivered",
        message: "Status event delivered."
      }
    ]
  };
}

describe("sf status command", () => {
  it("prints pull request status details and exits cleanly", async () => {
    let stdout = "";
    let receivedInput:
      | { repository?: string; pull_request: string; notifiers?: Array<{ adapter_id: string }> }
      | undefined;

    const exitCode = await runCli(
      [
        "node",
        "sf",
        "status",
        "--repo",
        "iKwesi/SpecForge",
        "--pr",
        "123",
        "--notify-webhook",
        "https://hooks.example.test/specforge"
      ],
      {
        stdout: {
          write(chunk: string) {
            stdout += chunk;
            return true;
          }
        },
        status_runner: async (input) => {
          receivedInput = {
            pull_request: input.pull_request,
            ...(input.repository ? { repository: input.repository } : {}),
            ...(input.notifiers
              ? { notifiers: input.notifiers.map((notifier) => ({ adapter_id: notifier.adapter_id })) }
              : {})
          };
          return buildStatusResult();
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(receivedInput).toEqual({
      repository: "iKwesi/SpecForge",
      pull_request: "123",
      notifiers: [{ adapter_id: "webhook" }]
    });
    expect(stdout).toContain("SpecForge Status");
    expect(stdout).toContain("Pull Request: #123");
    expect(stdout).toContain("Notifications");
    expect(stdout).toContain("- webhook delivered: Status event delivered.");
  });

  it("returns exit code 1 when the status command fails", async () => {
    let stderr = "";

    const exitCode = await runCli(["node", "sf", "status", "--pr", "123"], {
      stderr: {
        write(chunk: string) {
          stderr += chunk;
          return true;
        }
      },
      status_runner: async () => {
        throw new Error("status failed");
      }
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("status failed");
  });
});
