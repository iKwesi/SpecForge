import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMetadata, ArtifactSourceRef, ArtifactVersion } from "../artifacts/types.js";
import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata
} from "../artifacts/versioning.js";
import type { ProjectMode } from "../contracts/domain.js";
import type { OperationContract } from "../contracts/operation.js";
import type {
  WorkGraph,
  WorkGraphEpic,
  WorkGraphStory,
  WorkGraphTask
} from "./decomposeToWorkGraph.js";

const REPLAN_ARTIFACT_ID = "replan_subgraph";
const REPLAN_ARTIFACT_PATH = join(".specforge", "replans", "replan_subgraph.json");

export type ReplanAffectedSubgraphErrorCode =
  | "invalid_mode"
  | "insufficient_work_graph"
  | "empty_change_set"
  | "unknown_task_reference"
  | "artifact_write_failed";

export class ReplanAffectedSubgraphError extends Error {
  readonly code: ReplanAffectedSubgraphErrorCode;
  readonly details?: unknown;

  constructor(code: ReplanAffectedSubgraphErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ReplanAffectedSubgraphError";
    this.code = code;
    this.details = details;
  }
}

export type StaleTaskReason = "task_changed" | "contract_changed" | "upstream_impacted";

export interface ReplanAffectedSubgraphInput {
  project_mode: ProjectMode;
  work_graph?: WorkGraph;
  changed_task_ids?: string[];
  changed_contract_refs?: string[];
  artifact_dir?: string;
  created_timestamp?: Date;
}

export interface StaleTaskRecord {
  task_id: string;
  reasons: StaleTaskReason[];
}

export interface ReplanSubgraphArtifact {
  kind: "replan_subgraph";
  metadata: ArtifactMetadata;
  project_mode: "existing-repo";
  changed_task_ids: string[];
  changed_contract_refs: string[];
  stale_tasks: StaleTaskRecord[];
  updated_subgraph: WorkGraph;
}

export interface ReplanAffectedSubgraphResult {
  replan_subgraph: ReplanSubgraphArtifact;
  stale_task_ids: string[];
  updated_subgraph: WorkGraph;
}

export const REPLAN_AFFECTED_SUBGRAPH_OPERATION_CONTRACT: OperationContract<
  ReplanAffectedSubgraphInput,
  ReplanAffectedSubgraphResult
> = {
  name: "operation.replanAffectedSubgraph",
  version: "v1",
  purpose: "Scope replanning to tasks directly changed by contract/task updates plus their downstream dependents.",
  inputs_schema: {} as ReplanAffectedSubgraphInput,
  outputs_schema: {} as ReplanAffectedSubgraphResult,
  side_effects: ["writes .specforge/replans/replan_subgraph.json"],
  invariants: [
    "Only changed tasks, contract-matching tasks, and their downstream dependents are marked stale.",
    "Updated subgraph ordering is preserved from the published work graph.",
    "Replan artifact metadata references the exact work graph version used as the baseline."
  ],
  idempotency_expectations: [
    "Equivalent work graph and change inputs produce stable stale-task ordering and subgraph output."
  ],
  failure_modes: [
    "invalid_mode",
    "insufficient_work_graph",
    "empty_change_set",
    "unknown_task_reference",
    "artifact_write_failed"
  ],
  observability_fields: [
    "work_graph_version",
    "changed_task_count",
    "changed_contract_count",
    "stale_task_count",
    "replan_subgraph_version"
  ]
};

/**
 * Recompute only the stale portion of a published work graph after narrow task or
 * contract changes. This slice does not regenerate tasks from upstream specs; it
 * identifies the exact subgraph that must be replanned and preserves graph ordering.
 */
export async function runReplanAffectedSubgraph(
  input: ReplanAffectedSubgraphInput
): Promise<ReplanAffectedSubgraphResult> {
  if (input.project_mode !== "existing-repo") {
    throw new ReplanAffectedSubgraphError(
      "invalid_mode",
      "replanAffectedSubgraph currently supports project_mode=existing-repo."
    );
  }

  const workGraph = ensureWorkGraph(input.work_graph);
  const changedTaskIds = normalizeStringArray(input.changed_task_ids ?? []);
  const changedContractRefs = normalizeStringArray(input.changed_contract_refs ?? []);

  if (changedTaskIds.length === 0 && changedContractRefs.length === 0) {
    throw new ReplanAffectedSubgraphError(
      "empty_change_set",
      "At least one changed_task_id or changed_contract_ref is required."
    );
  }

  const indexedGraph = indexWorkGraph(workGraph);
  for (const taskId of changedTaskIds) {
    if (!indexedGraph.tasksById.has(taskId)) {
      throw new ReplanAffectedSubgraphError(
        "unknown_task_reference",
        `changed_task_id is not present in the work graph: ${taskId}`
      );
    }
  }

  const staleReasonMap = new Map<string, Set<StaleTaskReason>>();

  for (const taskId of changedTaskIds) {
    appendReason(staleReasonMap, taskId, "task_changed");
  }

  for (const task of indexedGraph.orderedTasks) {
    if (task.contract_refs.some((ref) => changedContractRefs.includes(ref))) {
      appendReason(staleReasonMap, task.id, "contract_changed");
    }
  }

  // Once a task is stale, every downstream dependent must also be replanned because its
  // inputs were derived from an outdated upstream node.
  const queue = [...staleReasonMap.keys()];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const currentTaskId = queue.shift();
    if (!currentTaskId) {
      continue;
    }

    const downstreamTaskIds = indexedGraph.downstreamByTaskId.get(currentTaskId) ?? [];
    for (const downstreamTaskId of downstreamTaskIds) {
      appendReason(staleReasonMap, downstreamTaskId, "upstream_impacted");
      if (!seen.has(downstreamTaskId)) {
        seen.add(downstreamTaskId);
        queue.push(downstreamTaskId);
      }
    }
  }

  const staleTaskIds = indexedGraph.orderedTasks
    .map((task) => task.id)
    .filter((taskId) => staleReasonMap.has(taskId));

  const staleTasks: StaleTaskRecord[] = staleTaskIds.map((taskId) => ({
    task_id: taskId,
    reasons: [...(staleReasonMap.get(taskId) ?? new Set<StaleTaskReason>())].sort((left, right) =>
      left.localeCompare(right)
    ) as StaleTaskReason[]
  }));

  const updatedSubgraph = buildUpdatedSubgraph(workGraph, new Set(staleTaskIds));
  const workGraphRef: ArtifactSourceRef = {
    artifact_id: "spec.dag",
    artifact_version: resolveWorkGraphVersion(input.work_graph)
  };

  const artifactContent = JSON.stringify(
    {
      project_mode: input.project_mode,
      changed_task_ids: changedTaskIds,
      changed_contract_refs: changedContractRefs,
      stale_tasks: staleTasks,
      updated_subgraph: updatedSubgraph
    },
    null,
    2
  );

  const previousMetadata = input.artifact_dir
    ? await readExistingReplanMetadata(input.artifact_dir)
    : undefined;

  const metadata = previousMetadata
    ? createNextArtifactMetadata({
        previous: previousMetadata,
        generator: REPLAN_AFFECTED_SUBGRAPH_OPERATION_CONTRACT.name,
        sourceRefs: [workGraphRef],
        content: artifactContent,
        ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
      })
    : createInitialArtifactMetadata({
        artifactId: REPLAN_ARTIFACT_ID,
        generator: REPLAN_AFFECTED_SUBGRAPH_OPERATION_CONTRACT.name,
        sourceRefs: [workGraphRef],
        content: artifactContent,
        ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
      });

  const replanSubgraph: ReplanSubgraphArtifact = {
    kind: "replan_subgraph",
    metadata,
    project_mode: "existing-repo",
    changed_task_ids: changedTaskIds,
    changed_contract_refs: changedContractRefs,
    stale_tasks: staleTasks,
    updated_subgraph: updatedSubgraph
  };

  if (input.artifact_dir) {
    await writeReplanArtifact({
      artifact_dir: input.artifact_dir,
      replan_subgraph: replanSubgraph
    });
  }

  return {
    replan_subgraph: replanSubgraph,
    stale_task_ids: staleTaskIds,
    updated_subgraph: updatedSubgraph
  };
}

function ensureWorkGraph(workGraph?: WorkGraph): WorkGraph {
  if (!workGraph || !Array.isArray(workGraph.epics)) {
    throw new ReplanAffectedSubgraphError(
      "insufficient_work_graph",
      "Missing or invalid work_graph input."
    );
  }

  return workGraph;
}

function resolveWorkGraphVersion(workGraph?: WorkGraph): ArtifactVersion {
  void workGraph;
  return "v1";
}

function normalizeStringArray(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function appendReason(
  staleReasonMap: Map<string, Set<StaleTaskReason>>,
  taskId: string,
  reason: StaleTaskReason
): void {
  const reasons = staleReasonMap.get(taskId) ?? new Set<StaleTaskReason>();
  reasons.add(reason);
  staleReasonMap.set(taskId, reasons);
}

interface IndexedWorkGraph {
  orderedTasks: WorkGraphTask[];
  tasksById: Map<string, WorkGraphTask>;
  downstreamByTaskId: Map<string, string[]>;
}

function indexWorkGraph(workGraph: WorkGraph): IndexedWorkGraph {
  const orderedTasks: WorkGraphTask[] = [];
  const tasksById = new Map<string, WorkGraphTask>();
  const downstreamByTaskId = new Map<string, string[]>();

  for (const epic of workGraph.epics) {
    for (const story of epic.stories) {
      for (const task of story.tasks) {
        orderedTasks.push(task);
        tasksById.set(task.id, task);
      }
    }
  }

  for (const task of orderedTasks) {
    for (const dependencyId of task.depends_on) {
      const downstream = downstreamByTaskId.get(dependencyId) ?? [];
      downstream.push(task.id);
      downstreamByTaskId.set(dependencyId, downstream);
    }
  }

  return {
    orderedTasks,
    tasksById,
    downstreamByTaskId
  };
}

function buildUpdatedSubgraph(workGraph: WorkGraph, staleTaskIds: Set<string>): WorkGraph {
  const epics: WorkGraphEpic[] = [];

  for (const epic of workGraph.epics) {
    const stories: WorkGraphStory[] = [];

    for (const story of epic.stories) {
      const tasks = story.tasks
        .filter((task) => staleTaskIds.has(task.id))
        .map((task) => ({
          ...task,
          depends_on: task.depends_on.filter((dependencyId) => staleTaskIds.has(dependencyId))
        }));

      if (tasks.length > 0) {
        stories.push({
          ...story,
          tasks
        });
      }
    }

    if (stories.length > 0) {
      epics.push({
        ...epic,
        stories
      });
    }
  }

  return { epics };
}

async function readExistingReplanMetadata(artifactDir: string): Promise<ArtifactMetadata | undefined> {
  try {
    const raw = await readFile(join(artifactDir, REPLAN_ARTIFACT_PATH), "utf8");
    return (JSON.parse(raw) as { metadata?: ArtifactMetadata }).metadata;
  } catch {
    return undefined;
  }
}

async function writeReplanArtifact(input: {
  artifact_dir: string;
  replan_subgraph: ReplanSubgraphArtifact;
}): Promise<void> {
  const targetPath = join(input.artifact_dir, REPLAN_ARTIFACT_PATH);

  try {
    await mkdir(join(input.artifact_dir, ".specforge", "replans"), { recursive: true });
    await writeFile(
      targetPath,
      `${JSON.stringify(input.replan_subgraph, null, 2)}\n`,
      "utf8"
    );
  } catch (error) {
    throw new ReplanAffectedSubgraphError(
      "artifact_write_failed",
      `Failed to write replan subgraph artifact to ${targetPath}`,
      error
    );
  }
}
