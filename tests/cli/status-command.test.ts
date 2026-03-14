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
    }
  };
}

describe("sf status command", () => {
  it("prints pull request status details and exits cleanly", async () => {
    let stdout = "";
    let receivedInput: { repository?: string; pull_request?: string } | undefined;

    const exitCode = await runCli(["node", "sf", "status", "--repo", "iKwesi/SpecForge", "--pr", "123"], {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        }
      },
      status_runner: async (input) => {
        receivedInput = input;
        return buildStatusResult();
      }
    });

    expect(exitCode).toBe(0);
    expect(receivedInput).toEqual({
      repository: "iKwesi/SpecForge",
      pull_request: "123"
    });
    expect(stdout).toContain("SpecForge Status");
    expect(stdout).toContain("Pull Request: #123");
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
