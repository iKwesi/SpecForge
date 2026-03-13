import { describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import type { InspectResult } from "../../src/core/diagnostics/inspect.js";

function buildInspectResult(overrides: Partial<InspectResult> = {}): InspectResult {
  return {
    scan_mode: "standard",
    repository_root: "/workspace/specforge",
    repo_profile_path: "/workspace/specforge/.specforge/repo_profile.json",
    architecture_summary_path: "/workspace/specforge/.specforge/architecture_summary.json",
    repo_profile: {
      kind: "repo_profile",
      metadata: {
        artifact_id: "repo_profile",
        artifact_version: "v1",
        created_timestamp: "2026-03-13T23:59:00.000Z",
        generator: "operation.profileRepository",
        source_refs: [],
        checksum: "a".repeat(64)
      },
      project_mode: "existing-repo",
      repository_root: "/workspace/specforge",
      scan: {
        max_files: 200,
        scanned_file_count: 3,
        truncated: false,
        ignored_directories: [".git", ".specforge"]
      },
      evidence: {
        top_level_entries: ["README.md", "src"],
        sampled_files: ["src/api/routes.ts", "src/api/service.ts", "src/cli/main.ts"],
        extension_counts: [{ extension: ".ts", count: 3 }],
        detected_manifests: ["package.json"],
        detected_tooling: ["node", "typescript"]
      }
    },
    architecture_summary: {
      kind: "architecture_summary",
      metadata: {
        artifact_id: "architecture_summary",
        artifact_version: "v1",
        created_timestamp: "2026-03-13T23:59:01.000Z",
        generator: "operation.mapArchitectureFromRepo",
        source_refs: [{ artifact_id: "repo_profile", artifact_version: "v1" }],
        checksum: "b".repeat(64)
      },
      project_mode: "existing-repo",
      repository_root: "/workspace/specforge",
      subsystems: [
        {
          id: "src/api",
          label: "src/api",
          inferred_responsibility: "API/backend surface",
          file_count: 2,
          evidence_refs: ["src/api/routes.ts", "src/api/service.ts"],
          uncertainty: "low"
        }
      ],
      summary_markdown: "# Architecture Summary"
    },
    ...overrides
  };
}

describe("sf inspect command", () => {
  it("writes the inspect report and exits cleanly on success", async () => {
    let stdout = "";

    const exitCode = await runCli(["node", "sf", "inspect"], {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        }
      },
      inspect_runner: async () => buildInspectResult()
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("SpecForge Inspect");
    expect(stdout).toContain("repo_profile@v1");
    expect(stdout).toContain("src/api");
  });

  it("returns exit code 1 when inspect fails", async () => {
    let stderr = "";

    const exitCode = await runCli(["node", "sf", "inspect"], {
      stderr: {
        write(chunk: string) {
          stderr += chunk;
          return true;
        }
      },
      inspect_runner: async () => {
        throw new Error("inspect failed");
      }
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("inspect failed");
  });
});
