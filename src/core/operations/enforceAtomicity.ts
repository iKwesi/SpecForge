import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMetadata, ArtifactSourceRef, ArtifactVersion } from "../artifacts/types.js";
import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata,
  deriveArtifactVersion
} from "../artifacts/versioning.js";
import type { ProjectMode } from "../contracts/domain.js";
import type { OperationContract } from "../contracts/operation.js";
import type {
  WorkGraph,
  WorkGraphEpic,
  WorkGraphStory,
  WorkGraphTask
} from "./decomposeToWorkGraph.js";

const DAG_FILENAME = "dag.yaml";
const DEFAULT_MAX_TITLE_LENGTH = 64;
const DEFAULT_MAX_ACCEPTANCE_REFS = 1;

export type EnforceAtomicityErrorCode =
  | "invalid_mode"
  | "insufficient_work_graph"
  | "unsplittable_task"
  | "artifact_write_failed";

export class EnforceAtomicityError extends Error {
  readonly code: EnforceAtomicityErrorCode;
  readonly details?: unknown;

  constructor(code: EnforceAtomicityErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "EnforceAtomicityError";
    this.code = code;
    this.details = details;
  }
}

export interface EnforceAtomicityInput {
  project_mode: ProjectMode;
  work_graph?: WorkGraph;
  artifact_dir?: string;
  max_title_length?: number;
  max_acceptance_refs?: number;
  source_refs?: ArtifactSourceRef[];
  created_timestamp?: Date;
}

export interface DagArtifact {
  kind: "dag_yaml";
  metadata: ArtifactMetadata;
  source_refs: ArtifactSourceRef[];
  path: "spec/dag.yaml";
  content: string;
}

export interface EnforceAtomicityResult {
  refined_work_graph: WorkGraph;
  dag_artifact: DagArtifact;
}

export const ENFORCE_ATOMICITY_OPERATION_CONTRACT: OperationContract<
  EnforceAtomicityInput,
  EnforceAtomicityResult
> = {
  name: "operation.enforceAtomicity",
  version: "v1",
  purpose: "Refine work graph tasks into bounded atomic units while preserving dependency integrity.",
  inputs_schema: {} as EnforceAtomicityInput,
  outputs_schema: {} as EnforceAtomicityResult,
  side_effects: ["writes spec/dag.yaml"],
  invariants: [
    "Unsafe or oversized tasks are split into atomic units when possible.",
    "Dependencies are preserved when original tasks are refined into subtasks.",
    "Unsplitable oversized tasks fail with explicit typed errors."
  ],
  idempotency_expectations: [
    "Equivalent work_graph and thresholds produce deterministic task ordering and dag output."
  ],
  failure_modes: ["invalid_mode", "insufficient_work_graph", "unsplittable_task", "artifact_write_failed"],
  observability_fields: [
    "project_mode",
    "input_task_count",
    "output_task_count",
    "dag_version"
  ]
};

export async function runEnforceAtomicity(
  input: EnforceAtomicityInput
): Promise<EnforceAtomicityResult> {
  if (input.project_mode !== "existing-repo") {
    throw new EnforceAtomicityError(
      "invalid_mode",
      "enforceAtomicity currently supports project_mode=existing-repo."
    );
  }

  const workGraph = ensureWorkGraph(input.work_graph);
  const maxTitleLength = normalizePositiveInteger(input.max_title_length, DEFAULT_MAX_TITLE_LENGTH, "max_title_length");
  const maxAcceptanceRefs = normalizePositiveInteger(
    input.max_acceptance_refs,
    DEFAULT_MAX_ACCEPTANCE_REFS,
    "max_acceptance_refs"
  );

  const refinedGraph = refineWorkGraph(workGraph, {
    max_title_length: maxTitleLength,
    max_acceptance_refs: maxAcceptanceRefs
  });

  const previousVersion = await readExistingDagVersion(input.artifact_dir);
  const dagVersion = deriveArtifactVersion(previousVersion);
  const dagContent = renderDagYaml({
    version: dagVersion,
    graph: refinedGraph
  });

  const sourceRefs = normalizeSourceRefs(input.source_refs ?? []);
  const metadata = createDagMetadata({
    source_refs: sourceRefs,
    content: dagContent,
    ...(previousVersion ? { previous_version: previousVersion } : {}),
    ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
  });

  const dagArtifact: DagArtifact = {
    kind: "dag_yaml",
    metadata,
    source_refs: sourceRefs,
    path: "spec/dag.yaml",
    content: dagContent
  };

  if (input.artifact_dir) {
    await writeDagArtifact(input.artifact_dir, dagContent);
  }

  return {
    refined_work_graph: refinedGraph,
    dag_artifact: dagArtifact
  };
}

function ensureWorkGraph(workGraph?: WorkGraph): WorkGraph {
  if (!workGraph || !Array.isArray(workGraph.epics)) {
    throw new EnforceAtomicityError("insufficient_work_graph", "Missing or invalid work_graph.");
  }

  return workGraph;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new EnforceAtomicityError("insufficient_work_graph", `${fieldName} must be a positive integer.`);
  }

  return value;
}

interface RefineThresholds {
  max_title_length: number;
  max_acceptance_refs: number;
}

interface TaskExpansion {
  source_task_id: string;
  title: string;
  acceptance_refs: string[];
  contract_refs: string[];
  split_index: number;
  split_total: number;
  source_depends_on: string[];
}

function refineWorkGraph(workGraph: WorkGraph, thresholds: RefineThresholds): WorkGraph {
  let globalTaskCounter = 1;

  const refinedEpics: WorkGraphEpic[] = workGraph.epics.map((epic) => {
    const refinedStories: WorkGraphStory[] = epic.stories.map((story) => {
      const expansions: TaskExpansion[] = [];
      const sourceToGeneratedIds = new Map<string, string[]>();

      for (const task of story.tasks) {
        const taskExpansions = expandTask(task, thresholds);
        expansions.push(...taskExpansions);
        sourceToGeneratedIds.set(task.id, []);
      }

      const tasks: WorkGraphTask[] = [];

      for (const expansion of expansions) {
        const taskId = `TASK-${globalTaskCounter}`;
        globalTaskCounter += 1;

        const previousIds = sourceToGeneratedIds.get(expansion.source_task_id);
        if (!previousIds) {
          throw new EnforceAtomicityError(
            "insufficient_work_graph",
            `Missing source task mapping for ${expansion.source_task_id}.`
          );
        }

        const dependsOn = expansion.split_index === 0
          ? mapDependencies(expansion.source_depends_on, sourceToGeneratedIds)
          : [previousIds[previousIds.length - 1]!];

        const normalizedDependsOn = [...new Set(dependsOn)];

        tasks.push({
          id: taskId,
          title: expansion.title,
          acceptance_refs: [...expansion.acceptance_refs],
          contract_refs: [...expansion.contract_refs],
          depends_on: normalizedDependsOn
        });

        previousIds.push(taskId);
      }

      return {
        id: story.id,
        title: story.title,
        tasks
      };
    });

    return {
      id: epic.id,
      title: epic.title,
      stories: refinedStories
    };
  });

  return {
    epics: refinedEpics
  };
}

function mapDependencies(
  sourceDependsOn: string[],
  sourceToGeneratedIds: Map<string, string[]>
): string[] {
  const resolved: string[] = [];

  for (const dependency of sourceDependsOn) {
    const generated = sourceToGeneratedIds.get(dependency);
    if (!generated || generated.length === 0) {
      resolved.push(dependency);
      continue;
    }

    resolved.push(generated[generated.length - 1]!);
  }

  return resolved;
}

function expandTask(task: WorkGraphTask, thresholds: RefineThresholds): TaskExpansion[] {
  const byAcceptance = splitByAcceptanceRefs(task, thresholds.max_acceptance_refs);

  const expansions: TaskExpansion[] = [];
  for (const acceptanceSplit of byAcceptance) {
    const splitTitles = splitTitleToAtomic(acceptanceSplit.title, thresholds.max_title_length);
    if (!splitTitles) {
      throw new EnforceAtomicityError(
        "unsplittable_task",
        `Task ${task.id} cannot be split safely under current atomicity thresholds.`,
        {
          task_id: task.id,
          title: task.title,
          max_title_length: thresholds.max_title_length,
          max_acceptance_refs: thresholds.max_acceptance_refs
        }
      );
    }

    for (const titlePart of splitTitles) {
      expansions.push({
        source_task_id: task.id,
        title: titlePart,
        acceptance_refs: acceptanceSplit.acceptance_refs,
        contract_refs: acceptanceSplit.contract_refs,
        split_index: expansions.length,
        split_total: 0,
        source_depends_on: [...task.depends_on]
      });
    }
  }

  return expansions.map((expansion, index, all) => ({
    ...expansion,
    split_index: index,
    split_total: all.length
  }));
}

interface BasicTaskChunk {
  title: string;
  acceptance_refs: string[];
  contract_refs: string[];
}

function splitByAcceptanceRefs(task: WorkGraphTask, maxAcceptanceRefs: number): BasicTaskChunk[] {
  if (task.acceptance_refs.length <= maxAcceptanceRefs) {
    return [
      {
        title: normalizeTitle(task.title),
        acceptance_refs: [...task.acceptance_refs],
        contract_refs: [...task.contract_refs]
      }
    ];
  }

  return task.acceptance_refs.map((acceptanceRef) => ({
    title: normalizeTitle(task.title),
    acceptance_refs: [acceptanceRef],
    contract_refs: [...task.contract_refs]
  }));
}

function splitTitleToAtomic(title: string, maxTitleLength: number): string[] | undefined {
  const normalized = normalizeTitle(title);
  if (normalized.length <= maxTitleLength) {
    return [normalized];
  }

  const segments = splitTitleSegment(normalized, maxTitleLength);
  if (!segments || segments.length === 0) {
    return undefined;
  }

  return segments;
}

function splitTitleSegment(segment: string, maxTitleLength: number): string[] | undefined {
  const normalizedSegment = normalizeTitle(segment);
  if (normalizedSegment.length <= maxTitleLength) {
    return [normalizedSegment];
  }

  const byAnd = normalizedSegment
    .split(/\band\b/i)
    .map((part) => normalizeTitle(part))
    .filter((part) => part.length > 0);

  if (byAnd.length > 1) {
    const result: string[] = [];
    for (const part of byAnd) {
      const nested = splitTitleSegment(part, maxTitleLength);
      if (!nested) {
        return undefined;
      }
      result.push(...nested);
    }

    return result;
  }

  const words = normalizedSegment.split(/\s+/).filter((word) => word.length > 0);
  if (words.length < 2) {
    return undefined;
  }

  const midpoint = Math.ceil(words.length / 2);
  const left = normalizeTitle(words.slice(0, midpoint).join(" "));
  const right = normalizeTitle(words.slice(midpoint).join(" "));

  if (left.length === 0 || right.length === 0 || left === normalizedSegment) {
    return undefined;
  }

  const leftSplit = splitTitleSegment(left, maxTitleLength);
  const rightSplit = splitTitleSegment(right, maxTitleLength);

  if (!leftSplit || !rightSplit) {
    return undefined;
  }

  return [...leftSplit, ...rightSplit];
}

function normalizeTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : "Untitled task";
}

function normalizeSourceRefs(sourceRefs: ArtifactSourceRef[]): ArtifactSourceRef[] {
  const deduped = new Map<string, ArtifactSourceRef>();

  for (const ref of sourceRefs) {
    const key = `${ref.artifact_id}@${ref.artifact_version}`;
    deduped.set(key, {
      artifact_id: ref.artifact_id,
      artifact_version: ref.artifact_version
    });
  }

  return [...deduped.values()].sort((left, right) => {
    if (left.artifact_id !== right.artifact_id) {
      return left.artifact_id.localeCompare(right.artifact_id);
    }

    return left.artifact_version.localeCompare(right.artifact_version);
  });
}

interface RenderDagYamlInput {
  version: ArtifactVersion;
  graph: WorkGraph;
}

function renderDagYaml(input: RenderDagYamlInput): string {
  const lines: string[] = [`version: ${input.version}`, "epics:"];

  for (const epic of input.graph.epics) {
    lines.push(`  - id: ${epic.id}`);
    lines.push(`    title: ${toYamlString(epic.title)}`);
    lines.push("    stories:");

    for (const story of epic.stories) {
      lines.push(`      - id: ${story.id}`);
      lines.push(`        title: ${toYamlString(story.title)}`);
      lines.push("        tasks:");

      for (const task of story.tasks) {
        lines.push(`          - id: ${task.id}`);
        lines.push(`            title: ${toYamlString(task.title)}`);
        lines.push("            acceptance_refs:");
        for (const acceptanceRef of task.acceptance_refs) {
          lines.push(`              - ${acceptanceRef}`);
        }
        lines.push("            contract_refs:");
        for (const contractRef of task.contract_refs) {
          lines.push(`              - ${contractRef}`);
        }
        if (task.depends_on.length === 0) {
          lines.push("            depends_on: []");
        } else {
          lines.push("            depends_on:");
          for (const dependency of task.depends_on) {
            lines.push(`              - ${dependency}`);
          }
        }
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function toYamlString(value: string): string {
  return JSON.stringify(value);
}

interface CreateDagMetadataInput {
  source_refs: ArtifactSourceRef[];
  content: string;
  previous_version?: ArtifactVersion;
  created_timestamp?: Date;
}

function createDagMetadata(input: CreateDagMetadataInput): ArtifactMetadata {
  if (!input.previous_version) {
    return createInitialArtifactMetadata({
      artifactId: "dag.yaml",
      generator: "operation.enforceAtomicity",
      sourceRefs: input.source_refs,
      content: input.content,
      ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
    });
  }

  return createNextArtifactMetadata({
    previous: {
      artifact_id: "dag.yaml",
      artifact_version: input.previous_version,
      created_timestamp: "1970-01-01T00:00:00.000Z",
      generator: "operation.enforceAtomicity",
      source_refs: input.source_refs,
      checksum: "0".repeat(64)
    },
    generator: "operation.enforceAtomicity",
    sourceRefs: input.source_refs,
    content: input.content,
    ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
  });
}

async function readExistingDagVersion(artifactDir?: string): Promise<ArtifactVersion | undefined> {
  if (!artifactDir) {
    return undefined;
  }

  try {
    const raw = await readFile(join(artifactDir, "spec", DAG_FILENAME), "utf8");
    const match = /^version:\s*(v\d+)\s*$/m.exec(raw);
    if (!match || !match[1]) {
      return undefined;
    }

    return match[1] as ArtifactVersion;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw new EnforceAtomicityError(
      "artifact_write_failed",
      "Failed to inspect existing dag.yaml artifact.",
      error
    );
  }
}

async function writeDagArtifact(artifactDir: string, dagContent: string): Promise<void> {
  const specDir = join(artifactDir, "spec");

  try {
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, DAG_FILENAME), dagContent, "utf8");
  } catch (error) {
    throw new EnforceAtomicityError(
      "artifact_write_failed",
      "Failed writing dag.yaml artifact.",
      error
    );
  }
}
