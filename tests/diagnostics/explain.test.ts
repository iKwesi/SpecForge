import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createDefaultPolicyConfig } from "../../src/core/contracts/policy.js";
import {
  ExplainError,
  formatExplainReport,
  runExplain
} from "../../src/core/diagnostics/explain.js";
import type { ConservativeSchedule } from "../../src/core/execution/scheduler.js";

async function writeJsonFile(dir: string, name: string, value: unknown): Promise<string> {
  const filePath = join(dir, name);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function buildArtifact() {
  return {
    kind: "task_execution_result",
    metadata: {
      artifact_id: "task_execution_result.task-1",
      artifact_version: "v2",
      parent_version: "v1",
      created_timestamp: "2026-03-12T23:30:00.000Z",
      generator: "operation.devTDDTask",
      source_refs: [
        {
          artifact_id: "context_pack.task-1",
          artifact_version: "v4"
        }
      ],
      checksum: "a".repeat(64)
    },
    task_id: "TASK-1",
    status: "completed"
  };
}

function buildSchedule(): ConservativeSchedule {
  return {
    policy: {
      max_concurrent_tasks: 2,
      serialize_on_uncertainty: true
    },
    batches: [
      {
        batch_id: "batch-1",
        execution_mode: "serial",
        task_ids: ["TASK-1"],
        reasons: ["uncertain_touch_set"]
      }
    ]
  };
}

describe("runExplain failure paths", () => {
  it("fails with a typed error when no artifact files are provided", async () => {
    await expect(
      runExplain({
        artifact_files: []
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ExplainError>>({
        code: "missing_artifact_input"
      })
    );
  });

  it("fails with a typed error when an artifact file is missing metadata", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "specforge-explain-"));
    const artifactFile = await writeJsonFile(tempDir, "broken-artifact.json", {
      kind: "task_execution_result"
    });

    await expect(
      runExplain({
        artifact_files: [artifactFile]
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ExplainError>>({
        code: "invalid_artifact"
      })
    );
  });

  it("fails with actionable validation details when a policy file is invalid", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "specforge-explain-"));
    const artifactFile = await writeJsonFile(tempDir, "task_execution_result.json", buildArtifact());
    const policyFile = await writeJsonFile(tempDir, "policy.json", {
      coverage: {
        scope: "full-repo",
        enforcement: "warn-only"
      },
      parallelism: {
        max_concurrent_tasks: 0,
        serialize_on_uncertainty: "yes"
      },
      gates: createDefaultPolicyConfig().gates
    });

    await expect(
      runExplain({
        artifact_files: [artifactFile],
        policy_file: policyFile
      })
    ).rejects.toThrow(/coverage\.scope .*; .*coverage\.enforcement .*; .*parallelism\.max_concurrent_tasks .*; \.\.\.and 1 more/);

    await expect(
      runExplain({
        artifact_files: [artifactFile],
        policy_file: policyFile
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ExplainError>>({
        code: "invalid_policy"
      })
    );
  });
});

describe("runExplain success paths", () => {
  it("renders deterministic evidence grounded in artifact, policy, and scheduler files", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "specforge-explain-"));
    const artifactFile = await writeJsonFile(tempDir, "task_execution_result.json", buildArtifact());
    const policyFile = await writeJsonFile(tempDir, "policy.json", createDefaultPolicyConfig());
    const scheduleFile = await writeJsonFile(tempDir, "schedule.json", buildSchedule());

    const result = await runExplain({
      artifact_files: [artifactFile],
      policy_file: policyFile,
      schedule_file: scheduleFile
    });

    expect(result.artifacts).toEqual([
      expect.objectContaining({
        path: artifactFile,
        artifact_id: "task_execution_result.task-1",
        artifact_version: "v2",
        generator: "operation.devTDDTask"
      })
    ]);
    expect(result.policy).toEqual(
      expect.objectContaining({
        source: policyFile,
        parallelism: {
          max_concurrent_tasks: 2,
          serialize_on_uncertainty: true
        }
      })
    );
    expect(result.schedule).toEqual(
      expect.objectContaining({
        source: scheduleFile,
        batches: [
          expect.objectContaining({
            batch_id: "batch-1",
            reasons: ["uncertain_touch_set"]
          })
        ]
      })
    );

    const report = formatExplainReport(result);
    expect(report).toContain("SpecForge Explain");
    expect(report).toContain("task_execution_result.task-1");
    expect(report).toContain("generator: operation.devTDDTask");
    expect(report).toContain("batch-1");
    expect(report).toContain("uncertain_touch_set");
    expect(report).toContain("max_concurrent_tasks: 2");
  });
});
