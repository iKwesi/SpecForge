import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { TaskExecutionResultArtifact } from "../../src/core/operations/devTDDTask.js";
import {
  CriticRalphLoopError,
  runCriticRalphLoop
} from "../../src/core/operations/criticRalphLoop.js";
import { ARTIFACT_OWNERSHIP_REGISTRY, inferArtifactKindFromId } from "../../src/core/spec/ownership.js";

function buildTaskExecutionResult(
  overrides?: Partial<TaskExecutionResultArtifact>
): TaskExecutionResultArtifact {
  return {
    kind: "task_execution_result",
    metadata: {
      artifact_id: "task_execution_result.task-1",
      artifact_version: "v1",
      created_timestamp: "2026-03-13T00:00:00.000Z",
      generator: "operation.devTDDTask",
      source_refs: [{ artifact_id: "context_pack.task-1", artifact_version: "v2" }],
      checksum: "a".repeat(64)
    },
    project_mode: "existing-repo",
    task_id: "TASK-1",
    context_pack_ref: {
      artifact_id: "context_pack.task-1",
      artifact_version: "v2"
    },
    phase_order: ["red", "green", "refactor"],
    phases: [
      {
        phase: "red",
        status: "failed",
        summary: "Added a failing test first.",
        evidence: ["tests/task.test.ts"],
        commands: ["pnpm test -- --run tests/task.test.ts"]
      },
      {
        phase: "green",
        status: "passed",
        summary: "Implemented the minimal fix.",
        evidence: ["src/task.ts", "tests/task.test.ts"],
        commands: ["pnpm test -- --run tests/task.test.ts"]
      },
      {
        phase: "refactor",
        status: "passed",
        summary: "Refined implementation without regressions.",
        evidence: ["src/task.ts"],
        commands: ["pnpm test -- --run tests/task.test.ts", "pnpm typecheck"]
      }
    ],
    status: "completed",
    summary_markdown: "# Task Execution Result",
    ...overrides
  };
}

describe("criticRalphLoop failure paths", () => {
  it("fails with a typed error when task execution result is missing", async () => {
    await expect(
      runCriticRalphLoop({
        project_mode: "existing-repo",
        attempt_number: 1,
        critic_checks: []
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<CriticRalphLoopError>>({
        code: "insufficient_task_execution_result"
      })
    );
  });

  it("fails when required critic checks are missing", async () => {
    await expect(
      runCriticRalphLoop({
        project_mode: "existing-repo",
        task_execution_result: buildTaskExecutionResult(),
        attempt_number: 1,
        critic_checks: [
          {
            check_id: "tests_passed",
            passed: true,
            detail: "Task-focused tests passed."
          }
        ]
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<CriticRalphLoopError>>({
        code: "invalid_critic_checks"
      })
    );
  });

  it("fails when a retry reuses the same context pack version as a previous attempt", async () => {
    const first = await runCriticRalphLoop({
      project_mode: "existing-repo",
      task_execution_result: buildTaskExecutionResult(),
      attempt_number: 1,
      max_attempts: 2,
      critic_checks: [
        {
          check_id: "tests_passed",
          passed: false,
          detail: "Task-focused tests still fail."
        },
        {
          check_id: "acceptance_covered",
          passed: false,
          detail: "Acceptance evidence is still incomplete."
        },
        {
          check_id: "scope_respected",
          passed: true,
          detail: "Only in-scope files were touched."
        }
      ]
    });

    await expect(
      runCriticRalphLoop({
        project_mode: "existing-repo",
        task_execution_result: buildTaskExecutionResult(),
        attempt_number: 2,
        max_attempts: 2,
        previous_critic_results: [first.critic_result],
        critic_checks: [
          {
            check_id: "tests_passed",
            passed: false,
            detail: "Task-focused tests still fail."
          },
          {
            check_id: "acceptance_covered",
            passed: false,
            detail: "Acceptance evidence is still incomplete."
          },
          {
            check_id: "scope_respected",
            passed: true,
            detail: "Only in-scope files were touched."
          }
        ]
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<CriticRalphLoopError>>({
        code: "stale_context"
      })
    );
  });
});

describe("criticRalphLoop success paths", () => {
  it("registers critic results to operation.criticRalphLoop", () => {
    expect(ARTIFACT_OWNERSHIP_REGISTRY.critic_result.owner_operation).toBe(
      "operation.criticRalphLoop"
    );
    expect(inferArtifactKindFromId("critic_result.task-1")).toBe("critic_result");
  });

  it("accepts a task when all explicit critic checks pass", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-critic-accept-"));

    const result = await runCriticRalphLoop({
      project_mode: "existing-repo",
      task_execution_result: buildTaskExecutionResult(),
      attempt_number: 1,
      max_attempts: 3,
      critic_checks: [
        {
          check_id: "tests_passed",
          passed: true,
          detail: "Task-focused tests passed."
        },
        {
          check_id: "acceptance_covered",
          passed: true,
          detail: "Acceptance evidence is covered by the task output."
        },
        {
          check_id: "scope_respected",
          passed: true,
          detail: "Only in-scope files were touched."
        }
      ],
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-13T14:00:00.000Z")
    });

    expect(result.critic_result.metadata.artifact_id).toBe("critic_result.task-1");
    expect(result.critic_result.metadata.artifact_version).toBe("v1");
    expect(result.critic_result.decision).toBe("accept");
    expect(result.critic_result.requires_fresh_context).toBe(false);
    expect(result.critic_result.failed_check_ids).toEqual([]);
    expect(result.critic_result.next_attempt_number).toBeUndefined();
    expect(result.critic_result.summary_markdown).toContain("# Critic Result");
    expect(result.critic_result.summary_markdown).toContain("Decision: accept");

    const written = JSON.parse(
      await readFile(join(artifactDir, ".specforge", "critic-results", "TASK-1.json"), "utf8")
    );
    expect(written.decision).toBe("accept");
  });

  it("requests a bounded retry with fresh context when checks fail and attempts remain", async () => {
    const result = await runCriticRalphLoop({
      project_mode: "existing-repo",
      task_execution_result: buildTaskExecutionResult(),
      attempt_number: 1,
      max_attempts: 2,
      critic_checks: [
        {
          check_id: "tests_passed",
          passed: false,
          detail: "Task-focused tests still fail."
        },
        {
          check_id: "acceptance_covered",
          passed: false,
          detail: "Acceptance evidence is still incomplete."
        },
        {
          check_id: "scope_respected",
          passed: true,
          detail: "Only in-scope files were touched."
        }
      ]
    });

    expect(result.critic_result.decision).toBe("retry");
    expect(result.critic_result.requires_fresh_context).toBe(true);
    expect(result.critic_result.next_attempt_number).toBe(2);
    expect(result.critic_result.failed_check_ids).toEqual([
      "acceptance_covered",
      "tests_passed"
    ]);
  });

  it("halts deterministically when failed checks reach the max attempt bound", async () => {
    const first = await runCriticRalphLoop({
      project_mode: "existing-repo",
      task_execution_result: buildTaskExecutionResult(),
      attempt_number: 1,
      max_attempts: 2,
      critic_checks: [
        {
          check_id: "tests_passed",
          passed: false,
          detail: "Task-focused tests still fail."
        },
        {
          check_id: "acceptance_covered",
          passed: false,
          detail: "Acceptance evidence is still incomplete."
        },
        {
          check_id: "scope_respected",
          passed: true,
          detail: "Only in-scope files were touched."
        }
      ]
    });

    const second = await runCriticRalphLoop({
      project_mode: "existing-repo",
      task_execution_result: buildTaskExecutionResult({
        metadata: {
          artifact_id: "task_execution_result.task-1",
          artifact_version: "v2",
          created_timestamp: "2026-03-13T00:10:00.000Z",
          generator: "operation.devTDDTask",
          source_refs: [{ artifact_id: "context_pack.task-1", artifact_version: "v3" }],
          checksum: "b".repeat(64)
        },
        context_pack_ref: {
          artifact_id: "context_pack.task-1",
          artifact_version: "v3"
        }
      }),
      attempt_number: 2,
      max_attempts: 2,
      previous_critic_results: [first.critic_result],
      critic_checks: [
        {
          check_id: "tests_passed",
          passed: false,
          detail: "Task-focused tests still fail."
        },
        {
          check_id: "acceptance_covered",
          passed: true,
          detail: "Acceptance evidence is now covered."
        },
        {
          check_id: "scope_respected",
          passed: true,
          detail: "Only in-scope files were touched."
        }
      ]
    });

    expect(second.critic_result.decision).toBe("halt");
    expect(second.critic_result.requires_fresh_context).toBe(false);
    expect(second.critic_result.next_attempt_number).toBeUndefined();
    expect(second.critic_result.failed_check_ids).toEqual(["tests_passed"]);
  });

  it("increments critic result versions on subsequent persisted runs", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-critic-version-"));
    const input = {
      project_mode: "existing-repo" as const,
      task_execution_result: buildTaskExecutionResult(),
      attempt_number: 1,
      max_attempts: 3,
      critic_checks: [
        {
          check_id: "tests_passed" as const,
          passed: true,
          detail: "Task-focused tests passed."
        },
        {
          check_id: "acceptance_covered" as const,
          passed: true,
          detail: "Acceptance evidence is covered by the task output."
        },
        {
          check_id: "scope_respected" as const,
          passed: true,
          detail: "Only in-scope files were touched."
        }
      ],
      artifact_dir: artifactDir
    };

    await runCriticRalphLoop({
      ...input,
      created_timestamp: new Date("2026-03-13T14:10:00.000Z")
    });

    const second = await runCriticRalphLoop({
      ...input,
      created_timestamp: new Date("2026-03-13T14:15:00.000Z")
    });

    expect(second.critic_result.metadata.artifact_version).toBe("v2");
    expect(second.critic_result.metadata.parent_version).toBe("v1");
  });
});
