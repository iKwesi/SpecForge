import {
  createDefaultPolicyConfig,
  type ParallelismPolicy
} from "../contracts/policy.js";

export type TouchSetConfidence = "high" | "uncertain";
export type ContractImpact = "contained" | "uncertain";
export type ScheduleReason =
  | "safe_parallel_batch"
  | "single_task_batch"
  | "uncertain_touch_set"
  | "uncertain_contract_impact"
  | "touch_set_overlap"
  | "shared_mutable_asset_overlap";

export interface SchedulableTask {
  task_id: string;
  touch_set: string[];
  touch_set_confidence: TouchSetConfidence;
  contract_impact: ContractImpact;
  shared_mutable_assets: string[];
}

export interface ConservativeScheduleBatch {
  batch_id: string;
  execution_mode: "serial" | "parallel";
  task_ids: string[];
  reasons: ScheduleReason[];
}

export interface ConservativeSchedule {
  policy: ParallelismPolicy;
  batches: ConservativeScheduleBatch[];
}

export interface BuildConservativeScheduleInput {
  tasks: SchedulableTask[];
  policy?: ParallelismPolicy;
}

export type ConservativeSchedulerErrorCode = "duplicate_task_id" | "invalid_policy" | "invalid_task";

export class ConservativeSchedulerError extends Error {
  readonly code: ConservativeSchedulerErrorCode;
  readonly details?: unknown;

  constructor(code: ConservativeSchedulerErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ConservativeSchedulerError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Build a conservative execution schedule without reordering tasks.
 *
 * The scheduler is intentionally greedy and order-preserving: it batches only adjacent
 * tasks that are proven safe to run together under the current policy. If confidence is
 * low or mutable scope overlaps, it falls back to serial execution instead of guessing.
 */
export function buildConservativeSchedule(
  input: BuildConservativeScheduleInput
): ConservativeSchedule {
  const policy = normalizePolicy(input.policy);
  const tasks = normalizeTasks(input.tasks);
  const batches: ConservativeScheduleBatch[] = [];
  let batchCounter = 1;
  let currentCandidateBatch: SchedulableTask[] = [];

  const flushCurrentBatch = (closingReasons?: ScheduleReason[]): void => {
    if (currentCandidateBatch.length === 0) {
      return;
    }

    if (currentCandidateBatch.length === 1) {
      batches.push({
        batch_id: `batch-${batchCounter}`,
        execution_mode: "serial",
        task_ids: [currentCandidateBatch[0]!.task_id],
        reasons: closingReasons && closingReasons.length > 0 ? [...closingReasons] : ["single_task_batch"]
      });
      batchCounter += 1;
      currentCandidateBatch = [];
      return;
    }

    batches.push({
      batch_id: `batch-${batchCounter}`,
      execution_mode: "parallel",
      task_ids: currentCandidateBatch.map((task) => task.task_id),
      reasons: ["safe_parallel_batch"]
    });
    batchCounter += 1;
    currentCandidateBatch = [];
  };

  for (const task of tasks) {
    const forcedSerialReasons = getForcedSerialReasons(task, policy);
    if (forcedSerialReasons.length > 0) {
      flushCurrentBatch();
      batches.push({
        batch_id: `batch-${batchCounter}`,
        execution_mode: "serial",
        task_ids: [task.task_id],
        reasons: forcedSerialReasons
      });
      batchCounter += 1;
      continue;
    }

    if (currentCandidateBatch.length === 0) {
      currentCandidateBatch = [task];
      continue;
    }

    const overlapReasons = getOverlapReasons(task, currentCandidateBatch);
    if (overlapReasons.length > 0) {
      // We do not reshuffle planning order to chase more parallelism. If a task collides
      // with the current batch candidate, we close the candidate safely and continue.
      flushCurrentBatch(overlapReasons);
      currentCandidateBatch = [task];
      continue;
    }

    if (currentCandidateBatch.length >= policy.max_concurrent_tasks) {
      flushCurrentBatch();
      currentCandidateBatch = [task];
      continue;
    }

    currentCandidateBatch.push(task);
  }

  flushCurrentBatch();

  return {
    policy,
    batches
  };
}

function normalizePolicy(policy?: ParallelismPolicy): ParallelismPolicy {
  const resolvedPolicy = policy ?? createDefaultPolicyConfig().parallelism;

  if (!Number.isInteger(resolvedPolicy.max_concurrent_tasks) || resolvedPolicy.max_concurrent_tasks <= 0) {
    throw new ConservativeSchedulerError(
      "invalid_policy",
      "max_concurrent_tasks must be a positive integer."
    );
  }

  return {
    max_concurrent_tasks: resolvedPolicy.max_concurrent_tasks,
    serialize_on_uncertainty: resolvedPolicy.serialize_on_uncertainty === true
  };
}

function normalizeTasks(tasks: SchedulableTask[]): SchedulableTask[] {
  const seenTaskIds = new Set<string>();

  return tasks.map((task) => {
    const taskId = task.task_id.trim();
    if (taskId.length === 0) {
      throw new ConservativeSchedulerError("invalid_task", "task_id must be non-empty.");
    }

    if (seenTaskIds.has(taskId)) {
      throw new ConservativeSchedulerError(
        "duplicate_task_id",
        `Duplicate task_id encountered: ${taskId}`
      );
    }
    seenTaskIds.add(taskId);

    return {
      task_id: taskId,
      touch_set: normalizeStringArray(task.touch_set),
      touch_set_confidence: task.touch_set_confidence,
      contract_impact: task.contract_impact,
      shared_mutable_assets: normalizeStringArray(task.shared_mutable_assets)
    };
  });
}

function getForcedSerialReasons(task: SchedulableTask, policy: ParallelismPolicy): ScheduleReason[] {
  if (!policy.serialize_on_uncertainty) {
    return [];
  }

  const reasons: ScheduleReason[] = [];
  if (task.touch_set_confidence === "uncertain") {
    reasons.push("uncertain_touch_set");
  }

  if (task.contract_impact === "uncertain") {
    reasons.push("uncertain_contract_impact");
  }

  return reasons;
}

function getOverlapReasons(task: SchedulableTask, batch: SchedulableTask[]): ScheduleReason[] {
  const reasons: ScheduleReason[] = [];

  for (const currentTask of batch) {
    if (hasIntersection(task.touch_set, currentTask.touch_set) && !reasons.includes("touch_set_overlap")) {
      reasons.push("touch_set_overlap");
    }

    if (
      hasIntersection(task.shared_mutable_assets, currentTask.shared_mutable_assets) &&
      !reasons.includes("shared_mutable_asset_overlap")
    ) {
      reasons.push("shared_mutable_asset_overlap");
    }
  }

  return reasons;
}

function hasIntersection(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }

  const rightValues = new Set(right);
  return left.some((value) => rightValues.has(value));
}

function normalizeStringArray(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right)
  );
}
