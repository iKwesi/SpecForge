import { describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import type { ExplainResult } from "../../src/core/diagnostics/explain.js";

function buildExplainResult(overrides: Partial<ExplainResult> = {}): ExplainResult {
  return {
    artifacts: [
      {
        path: "/workspace/.specforge/task-results/TASK-1.json",
        artifact_id: "task_execution_result.task-1",
        artifact_version: "v2",
        generator: "operation.devTDDTask",
        created_timestamp: "2026-03-12T23:30:00.000Z",
        source_refs: [
          {
            artifact_id: "context_pack.task-1",
            artifact_version: "v4"
          }
        ]
      }
    ],
    ...overrides
  };
}

describe("sf explain command", () => {
  it("writes the explain report and exits cleanly on success", async () => {
    let stdout = "";

    const exitCode = await runCli(["node", "sf", "explain", "--artifact-file", "artifact.json"], {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        }
      },
      explain_runner: async () => buildExplainResult()
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("SpecForge Explain");
    expect(stdout).toContain("task_execution_result.task-1");
  });

  it("returns exit code 1 when explain fails validation", async () => {
    let stderr = "";

    const exitCode = await runCli(["node", "sf", "explain"], {
      stderr: {
        write(chunk: string) {
          stderr += chunk;
          return true;
        }
      },
      explain_runner: async () => {
        throw new Error("missing artifact");
      }
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing artifact");
  });
});
