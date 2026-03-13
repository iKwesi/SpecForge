import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { ContextPackArtifact } from "../../src/core/operations/buildContextPack.js";
import {
  DevTddTaskError,
  runDevTddTask
} from "../../src/core/operations/devTDDTask.js";
import { ARTIFACT_OWNERSHIP_REGISTRY, inferArtifactKindFromId } from "../../src/core/spec/ownership.js";

function buildContextPack(overrides?: Partial<ContextPackArtifact>): ContextPackArtifact {
  return {
    kind: "context_pack",
    metadata: {
      artifact_id: "context_pack.task-1",
      artifact_version: "v2",
      created_timestamp: "2026-03-13T00:00:00.000Z",
      generator: "operation.buildContextPack",
      source_refs: [
        { artifact_id: "prd.json", artifact_version: "v2" },
        { artifact_id: "spec.main", artifact_version: "v1" }
      ],
      checksum: "a".repeat(64)
    },
    task: {
      id: "TASK-1",
      title: "Validate acceptance coverage",
      acceptance_refs: ["AC-1"],
      contract_refs: ["schemas/core.schema.json"],
      depends_on: []
    },
    entries: [
      {
        kind: "task_definition",
        source_ref: { artifact_id: "dag.yaml", artifact_version: "v1" },
        locator: "TASK-1",
        excerpt: "Task: Validate acceptance coverage"
      },
      {
        kind: "acceptance_excerpt",
        source_ref: { artifact_id: "acceptance.core", artifact_version: "v1" },
        locator: "AC-1",
        excerpt: "verify acceptance coverage"
      }
    ],
    ...overrides
  };
}

describe("devTDDTask failure paths", () => {
  it("fails with a typed error when context_pack is missing", async () => {
    await expect(
      runDevTddTask({
        project_mode: "existing-repo",
        phases: []
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<DevTddTaskError>>({
        code: "insufficient_context_pack"
      })
    );
  });

  it("fails when phases are not in strict red-green-refactor order", async () => {
    await expect(
      runDevTddTask({
        project_mode: "existing-repo",
        context_pack: buildContextPack(),
        phases: [
          {
            phase: "green",
            status: "passed",
            summary: "Implementation added.",
            evidence: ["src/task.ts"],
            commands: ["pnpm test -- --run tests/task.test.ts"]
          },
          {
            phase: "red",
            status: "failed",
            summary: "Test added and failing first.",
            evidence: ["tests/task.test.ts"],
            commands: ["pnpm test -- --run tests/task.test.ts"]
          },
          {
            phase: "refactor",
            status: "passed",
            summary: "Cleanup preserved passing state.",
            evidence: ["src/task.ts"],
            commands: ["pnpm test -- --run tests/task.test.ts"]
          }
        ]
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<DevTddTaskError>>({
        code: "invalid_tdd_sequence"
      })
    );
  });

  it("fails when phase outcomes violate the TDD contract", async () => {
    await expect(
      runDevTddTask({
        project_mode: "existing-repo",
        context_pack: buildContextPack(),
        phases: [
          {
            phase: "red",
            status: "passed",
            summary: "Test unexpectedly passed.",
            evidence: ["tests/task.test.ts"],
            commands: ["pnpm test -- --run tests/task.test.ts"]
          },
          {
            phase: "green",
            status: "passed",
            summary: "Implementation added.",
            evidence: ["src/task.ts"],
            commands: ["pnpm test -- --run tests/task.test.ts"]
          },
          {
            phase: "refactor",
            status: "passed",
            summary: "Cleanup preserved passing state.",
            evidence: ["src/task.ts"],
            commands: ["pnpm test -- --run tests/task.test.ts"]
          }
        ]
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<DevTddTaskError>>({
        code: "phase_contract_violation"
      })
    );
  });
});

describe("devTDDTask success paths", () => {
  it("registers task execution results to operation.devTDDTask", () => {
    expect(ARTIFACT_OWNERSHIP_REGISTRY.task_execution_result.owner_operation).toBe(
      "operation.devTDDTask"
    );
    expect(inferArtifactKindFromId("task_execution_result.task-1")).toBe("task_execution_result");
  });

  it("produces a versioned task execution result with structured phase output", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-dev-tdd-task-"));

    const result = await runDevTddTask({
      project_mode: "existing-repo",
      context_pack: buildContextPack(),
      branch_ref: "feat/task-1",
      pr_ref: "https://github.com/iKwesi/SpecForge/pull/999",
      phases: [
        {
          phase: "red",
          status: "failed",
          summary: "Added a failing acceptance-focused test.",
          evidence: ["tests/task.test.ts"],
          commands: ["pnpm test -- --run tests/task.test.ts"]
        },
        {
          phase: "green",
          status: "passed",
          summary: "Implemented the minimal production change.",
          evidence: ["src/task.ts", "tests/task.test.ts"],
          commands: ["pnpm test -- --run tests/task.test.ts"]
        },
        {
          phase: "refactor",
          status: "passed",
          summary: "Simplified the implementation and reran tests.",
          evidence: ["src/task.ts"],
          commands: ["pnpm test -- --run tests/task.test.ts", "pnpm typecheck"]
        }
      ],
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-13T13:00:00.000Z")
    });

    expect(result.task_execution_result.kind).toBe("task_execution_result");
    expect(result.task_execution_result.metadata.artifact_id).toBe("task_execution_result.task-1");
    expect(result.task_execution_result.metadata.artifact_version).toBe("v1");
    expect(result.task_execution_result.metadata.generator).toBe("operation.devTDDTask");
    expect(result.task_execution_result.status).toBe("completed");
    expect(result.task_execution_result.phase_order).toEqual(["red", "green", "refactor"]);
    expect(result.task_execution_result.branch_ref).toBe("feat/task-1");
    expect(result.task_execution_result.pr_ref).toBe(
      "https://github.com/iKwesi/SpecForge/pull/999"
    );
    expect(result.task_execution_result.context_pack_ref).toEqual({
      artifact_id: "context_pack.task-1",
      artifact_version: "v2"
    });
    expect(result.task_execution_result.summary_markdown).toContain("# Task Execution Result");
    expect(result.task_execution_result.summary_markdown).toContain("## Red");
    expect(result.task_execution_result.summary_markdown).toContain("## Refactor");

    const written = JSON.parse(
      await readFile(join(artifactDir, ".specforge", "task-results", "TASK-1.json"), "utf8")
    );
    expect(written.metadata.artifact_id).toBe("task_execution_result.task-1");
    expect(written.task_id).toBe("TASK-1");
  });

  it("increments task execution result versions on subsequent runs", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-dev-tdd-task-version-"));

    const input = {
      project_mode: "existing-repo" as const,
      context_pack: buildContextPack(),
      phases: [
        {
          phase: "red" as const,
          status: "failed" as const,
          summary: "Added a failing acceptance-focused test.",
          evidence: ["tests/task.test.ts"],
          commands: ["pnpm test -- --run tests/task.test.ts"]
        },
        {
          phase: "green" as const,
          status: "passed" as const,
          summary: "Implemented the minimal production change.",
          evidence: ["src/task.ts", "tests/task.test.ts"],
          commands: ["pnpm test -- --run tests/task.test.ts"]
        },
        {
          phase: "refactor" as const,
          status: "passed" as const,
          summary: "Simplified the implementation and reran tests.",
          evidence: ["src/task.ts"],
          commands: ["pnpm test -- --run tests/task.test.ts", "pnpm typecheck"]
        }
      ],
      artifact_dir: artifactDir
    };

    await runDevTddTask({
      ...input,
      created_timestamp: new Date("2026-03-13T13:10:00.000Z")
    });

    const second = await runDevTddTask({
      ...input,
      created_timestamp: new Date("2026-03-13T13:15:00.000Z")
    });

    expect(second.task_execution_result.metadata.artifact_version).toBe("v2");
    expect(second.task_execution_result.metadata.parent_version).toBe("v1");
  });
});
