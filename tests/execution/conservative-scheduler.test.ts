import { describe, expect, it } from "vitest";

import {
  ConservativeSchedulerError,
  buildConservativeSchedule,
  type SchedulableTask
} from "../../src/core/execution/scheduler.js";
import { createDefaultPolicyConfig } from "../../src/core/contracts/policy.js";

function buildTask(overrides: Partial<SchedulableTask> & Pick<SchedulableTask, "task_id">): SchedulableTask {
  const { task_id, ...rest } = overrides;
  return {
    task_id,
    touch_set: [],
    touch_set_confidence: "high",
    contract_impact: "contained",
    shared_mutable_assets: [],
    ...rest
  };
}

describe("conservative scheduler failure paths", () => {
  it("fails for duplicate task ids", () => {
    expect(() =>
      buildConservativeSchedule({
        tasks: [
          buildTask({ task_id: "TASK-1" }),
          buildTask({ task_id: "TASK-1" })
        ]
      })
    ).toThrowError(
      expect.objectContaining<Partial<ConservativeSchedulerError>>({
        code: "duplicate_task_id"
      })
    );
  });

  it("fails when max_concurrent_tasks is invalid", () => {
    expect(() =>
      buildConservativeSchedule({
        tasks: [buildTask({ task_id: "TASK-1" })],
        policy: {
          max_concurrent_tasks: 0,
          serialize_on_uncertainty: true
        }
      })
    ).toThrowError(
      expect.objectContaining<Partial<ConservativeSchedulerError>>({
        code: "invalid_policy"
      })
    );
  });
});

describe("conservative scheduler success paths", () => {
  it("uses the v1 default max concurrency of 2 for safe disjoint tasks", () => {
    const policy = createDefaultPolicyConfig().parallelism;

    const schedule = buildConservativeSchedule({
      tasks: [
        buildTask({ task_id: "TASK-1", touch_set: ["src/api/routes.ts"] }),
        buildTask({ task_id: "TASK-2", touch_set: ["src/cli/main.ts"] }),
        buildTask({ task_id: "TASK-3", touch_set: ["src/shared/types.ts"] })
      ],
      policy
    });

    expect(schedule.policy.max_concurrent_tasks).toBe(2);
    expect(schedule.batches).toEqual([
      {
        batch_id: "batch-1",
        execution_mode: "parallel",
        task_ids: ["TASK-1", "TASK-2"],
        reasons: ["safe_parallel_batch"]
      },
      {
        batch_id: "batch-2",
        execution_mode: "serial",
        task_ids: ["TASK-3"],
        reasons: ["single_task_batch"]
      }
    ]);
  });

  it("serializes uncertain tasks when serialize_on_uncertainty is enabled", () => {
    const schedule = buildConservativeSchedule({
      tasks: [
        buildTask({ task_id: "TASK-1", touch_set: ["src/api/routes.ts"] }),
        buildTask({
          task_id: "TASK-2",
          touch_set: ["src/api/service.ts"],
          touch_set_confidence: "uncertain"
        })
      ]
    });

    expect(schedule.batches).toEqual([
      {
        batch_id: "batch-1",
        execution_mode: "serial",
        task_ids: ["TASK-1"],
        reasons: ["single_task_batch"]
      },
      {
        batch_id: "batch-2",
        execution_mode: "serial",
        task_ids: ["TASK-2"],
        reasons: ["uncertain_touch_set"]
      }
    ]);
  });

  it("serializes tasks with uncertain contract impact", () => {
    const schedule = buildConservativeSchedule({
      tasks: [
        buildTask({
          task_id: "TASK-1",
          contract_impact: "uncertain",
          touch_set: ["src/contracts/public.ts"]
        })
      ]
    });

    expect(schedule.batches).toEqual([
      {
        batch_id: "batch-1",
        execution_mode: "serial",
        task_ids: ["TASK-1"],
        reasons: ["uncertain_contract_impact"]
      }
    ]);
  });

  it("prevents parallel batching when touch sets overlap or shared mutable assets overlap", () => {
    const schedule = buildConservativeSchedule({
      tasks: [
        buildTask({
          task_id: "TASK-1",
          touch_set: ["src/api/routes.ts"],
          shared_mutable_assets: ["spec.contracts"]
        }),
        buildTask({
          task_id: "TASK-2",
          touch_set: ["src/api/routes.ts"],
          shared_mutable_assets: ["spec.contracts"]
        })
      ]
    });

    expect(schedule.batches).toEqual([
      {
        batch_id: "batch-1",
        execution_mode: "serial",
        task_ids: ["TASK-1"],
        reasons: ["touch_set_overlap", "shared_mutable_asset_overlap"]
      },
      {
        batch_id: "batch-2",
        execution_mode: "serial",
        task_ids: ["TASK-2"],
        reasons: ["single_task_batch"]
      }
    ]);
  });

  it("respects stricter policy overrides like max_concurrent_tasks=1", () => {
    const schedule = buildConservativeSchedule({
      tasks: [
        buildTask({ task_id: "TASK-1", touch_set: ["src/api/routes.ts"] }),
        buildTask({ task_id: "TASK-2", touch_set: ["src/cli/main.ts"] })
      ],
      policy: {
        max_concurrent_tasks: 1,
        serialize_on_uncertainty: true
      }
    });

    expect(schedule.batches).toEqual([
      {
        batch_id: "batch-1",
        execution_mode: "serial",
        task_ids: ["TASK-1"],
        reasons: ["single_task_batch"]
      },
      {
        batch_id: "batch-2",
        execution_mode: "serial",
        task_ids: ["TASK-2"],
        reasons: ["single_task_batch"]
      }
    ]);
  });
});
