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
  AcceptanceArtifactInput,
  SchemaArtifactInput,
  WorkGraph,
  WorkGraphTask
} from "./decomposeToWorkGraph.js";
import type { PrdJsonArtifact } from "./generatePRD.js";
import type { SpecArtifactContract } from "../spec/contracts.js";

const CONTEXT_PACKS_DIR = join(".specforge", "context-packs");

export type ContextPackEntryKind =
  | "task_definition"
  | "acceptance_excerpt"
  | "contract_excerpt"
  | "prd_excerpt";

export interface ContextPackEntry {
  kind: ContextPackEntryKind;
  source_ref: ArtifactSourceRef;
  locator: string;
  excerpt: string;
}

export interface ContextPackArtifact {
  kind: "context_pack";
  metadata: ArtifactMetadata;
  task: WorkGraphTask;
  entries: ContextPackEntry[];
}

export interface BuildContextPackInput {
  project_mode: ProjectMode;
  task_id: string;
  work_graph?: WorkGraph;
  prd_json?: PrdJsonArtifact;
  spec_artifact?: SpecArtifactContract;
  acceptance_artifact?: AcceptanceArtifactInput;
  schema_artifact?: SchemaArtifactInput;
  artifact_dir?: string;
  created_timestamp?: Date;
}

export interface BuildContextPackResult {
  context_pack: ContextPackArtifact;
}

export type BuildContextPackErrorCode =
  | "invalid_mode"
  | "insufficient_work_graph"
  | "insufficient_prd"
  | "insufficient_spec"
  | "insufficient_acceptance"
  | "insufficient_contracts"
  | "task_not_found"
  | "artifact_write_failed";

export class BuildContextPackError extends Error {
  readonly code: BuildContextPackErrorCode;
  readonly details?: unknown;

  constructor(code: BuildContextPackErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BuildContextPackError";
    this.code = code;
    this.details = details;
  }
}

export const BUILD_CONTEXT_PACK_OPERATION_CONTRACT: OperationContract<
  BuildContextPackInput,
  BuildContextPackResult
> = {
  name: "operation.buildContextPack",
  version: "v1",
  purpose: "Build a minimal task-specific context pack with provenance-aware excerpts and version pins.",
  inputs_schema: {} as BuildContextPackInput,
  outputs_schema: {} as BuildContextPackResult,
  side_effects: ["writes .specforge/context-packs/<task_id>.json"],
  invariants: [
    "Context packs include only task-relevant excerpts.",
    "Every excerpt carries exact source artifact version provenance.",
    "Context pack artifacts are versioned and immutable per run."
  ],
  idempotency_expectations: [
    "Equivalent task + artifact inputs produce stable entry ordering and excerpt selection."
  ],
  failure_modes: [
    "invalid_mode",
    "insufficient_work_graph",
    "insufficient_prd",
    "insufficient_spec",
    "insufficient_acceptance",
    "insufficient_contracts",
    "task_not_found",
    "artifact_write_failed"
  ],
  observability_fields: [
    "task_id",
    "context_pack_version",
    "entry_count",
    "source_artifact_count"
  ]
};

export async function runBuildContextPack(
  input: BuildContextPackInput
): Promise<BuildContextPackResult> {
  if (input.project_mode !== "existing-repo") {
    throw new BuildContextPackError(
      "invalid_mode",
      "buildContextPack currently supports project_mode=existing-repo."
    );
  }

  const workGraph = ensureWorkGraph(input.work_graph);
  const prdJson = ensurePrdJson(input.prd_json);
  const specArtifact = ensureSpecArtifact(input.spec_artifact);
  const acceptanceArtifact = ensureAcceptanceArtifact(input.acceptance_artifact);
  const schemaArtifact = ensureSchemaArtifact(input.schema_artifact);
  const task = findTaskById(workGraph, input.task_id);

  if (!task) {
    throw new BuildContextPackError("task_not_found", `Task not found in work graph: ${input.task_id}`);
  }

  const entries = buildContextEntries({
    task,
    prd_json: prdJson,
    spec_artifact: specArtifact,
    acceptance_artifact: acceptanceArtifact,
    schema_artifact: schemaArtifact
  });

  const sourceRefs = dedupeSourceRefs(entries.map((entry) => entry.source_ref));
  const previousVersion = await readExistingContextPackVersion(
    input.artifact_dir
      ? {
          artifact_dir: input.artifact_dir,
          task_id: task.id
        }
      : {
          task_id: task.id
        }
  );

  const contextPack: ContextPackArtifact = {
    kind: "context_pack",
    metadata: createContextPackMetadata({
      task_id: task.id,
      source_refs: sourceRefs,
      content: JSON.stringify({ task, entries }),
      ...(previousVersion ? { previous_version: previousVersion } : {}),
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    }),
    task: {
      id: task.id,
      title: task.title,
      acceptance_refs: [...task.acceptance_refs],
      contract_refs: [...task.contract_refs],
      depends_on: [...task.depends_on]
    },
    entries
  };

  if (input.artifact_dir) {
    await writeContextPackArtifact({
      artifact_dir: input.artifact_dir,
      task_id: task.id,
      context_pack: contextPack
    });
  }

  return {
    context_pack: contextPack
  };
}

function ensureWorkGraph(workGraph?: WorkGraph): WorkGraph {
  if (!workGraph || !Array.isArray(workGraph.epics)) {
    throw new BuildContextPackError("insufficient_work_graph", "Missing or invalid work_graph.");
  }

  return workGraph;
}

function ensurePrdJson(artifact?: PrdJsonArtifact): PrdJsonArtifact {
  if (!artifact || artifact.kind !== "prd_json") {
    throw new BuildContextPackError("insufficient_prd", "Missing or invalid prd_json artifact.");
  }

  return artifact;
}

function ensureSpecArtifact(artifact?: SpecArtifactContract): SpecArtifactContract {
  if (!artifact || artifact.kind !== "spec") {
    throw new BuildContextPackError("insufficient_spec", "Missing or invalid spec artifact.");
  }

  return artifact;
}

function ensureAcceptanceArtifact(artifact?: AcceptanceArtifactInput): AcceptanceArtifactInput {
  if (!artifact || artifact.kind !== "acceptance_markdown") {
    throw new BuildContextPackError(
      "insufficient_acceptance",
      "Missing or invalid acceptance artifact."
    );
  }

  return artifact;
}

function ensureSchemaArtifact(artifact?: SchemaArtifactInput): SchemaArtifactInput {
  if (!artifact || artifact.kind !== "schema_json") {
    throw new BuildContextPackError("insufficient_contracts", "Missing or invalid schema artifact.");
  }

  return artifact;
}

function findTaskById(workGraph: WorkGraph, taskId: string): WorkGraphTask | undefined {
  for (const epic of workGraph.epics) {
    for (const story of epic.stories) {
      for (const task of story.tasks) {
        if (task.id === taskId) {
          return task;
        }
      }
    }
  }

  return undefined;
}

interface BuildContextEntriesInput {
  task: WorkGraphTask;
  prd_json: PrdJsonArtifact;
  spec_artifact: SpecArtifactContract;
  acceptance_artifact: AcceptanceArtifactInput;
  schema_artifact: SchemaArtifactInput;
}

function buildContextEntries(input: BuildContextEntriesInput): ContextPackEntry[] {
  const entries: ContextPackEntry[] = [
    {
      kind: "task_definition",
      source_ref: {
        artifact_id: "dag.yaml",
        artifact_version: "v1"
      },
      locator: input.task.id,
      excerpt: [
        `Task: ${input.task.title}`,
        `Acceptance refs: ${input.task.acceptance_refs.join(", ") || "<none>"}`,
        `Contract refs: ${input.task.contract_refs.join(", ") || "<none>"}`,
        `Depends on: ${input.task.depends_on.join(", ") || "<none>"}`
      ].join("\n")
    }
  ];

  for (const acceptanceRef of input.task.acceptance_refs) {
    const excerpt = extractAcceptanceExcerpt(input.acceptance_artifact.content, acceptanceRef);
    if (!excerpt) {
      continue;
    }

    entries.push({
      kind: "acceptance_excerpt",
      source_ref: {
        artifact_id: input.acceptance_artifact.metadata.artifact_id,
        artifact_version: input.acceptance_artifact.metadata.artifact_version
      },
      locator: acceptanceRef,
      excerpt
    });
  }

  for (const contractRef of input.task.contract_refs) {
    if (contractRef === "spec.contracts") {
      entries.push({
        kind: "contract_excerpt",
        source_ref: {
          artifact_id: input.spec_artifact.metadata.artifact_id,
          artifact_version: input.spec_artifact.metadata.artifact_version
        },
        locator: "contracts",
        excerpt: (input.spec_artifact.sections.contracts ?? "").trim()
      });
      continue;
    }

    if (contractRef === input.schema_artifact.path) {
      entries.push({
        kind: "contract_excerpt",
        source_ref: {
          artifact_id: input.schema_artifact.metadata.artifact_id,
          artifact_version: input.schema_artifact.metadata.artifact_version
        },
        locator: input.schema_artifact.path,
        excerpt: summarizeSchemaContent(input.schema_artifact.content)
      });
    }
  }

  entries.push({
    kind: "prd_excerpt",
    source_ref: {
      artifact_id: input.prd_json.metadata.artifact_id,
      artifact_version: input.prd_json.metadata.artifact_version
    },
    locator: "workflow",
    excerpt: input.prd_json.sections.workflow.trim()
  });

  return entries;
}

function extractAcceptanceExcerpt(content: string, acceptanceRef: string): string | undefined {
  const marker = `- ${acceptanceRef}:`;
  const line = content
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith(marker));

  if (!line) {
    return undefined;
  }

  return line.slice(marker.length).trim();
}

function summarizeSchemaContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      title?: string;
      type?: string;
      required?: string[];
    };

    const required = Array.isArray(parsed.required) ? parsed.required.join(", ") : "<none>";
    return [
      `title: ${parsed.title ?? "<unknown>"}`,
      `type: ${parsed.type ?? "<unknown>"}`,
      `required: ${required}`
    ].join("\n");
  } catch {
    return content.trim();
  }
}

function dedupeSourceRefs(sourceRefs: ArtifactSourceRef[]): ArtifactSourceRef[] {
  const byKey = new Map<string, ArtifactSourceRef>();

  for (const sourceRef of sourceRefs) {
    byKey.set(`${sourceRef.artifact_id}@${sourceRef.artifact_version}`, sourceRef);
  }

  return [...byKey.values()].sort((left, right) => {
    if (left.artifact_id !== right.artifact_id) {
      return left.artifact_id.localeCompare(right.artifact_id);
    }

    return left.artifact_version.localeCompare(right.artifact_version);
  });
}

interface CreateContextPackMetadataInput {
  task_id: string;
  source_refs: ArtifactSourceRef[];
  content: string;
  previous_version?: ArtifactVersion;
  created_timestamp?: Date;
}

function createContextPackMetadata(input: CreateContextPackMetadataInput): ArtifactMetadata {
  const artifactId = toContextPackArtifactId(input.task_id);

  if (!input.previous_version) {
    return createInitialArtifactMetadata({
      artifactId,
      generator: "operation.buildContextPack",
      sourceRefs: input.source_refs,
      content: input.content,
      ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
    });
  }

  return createNextArtifactMetadata({
    previous: {
      artifact_id: artifactId,
      artifact_version: input.previous_version,
      created_timestamp: "1970-01-01T00:00:00.000Z",
      generator: "operation.buildContextPack",
      source_refs: input.source_refs,
      checksum: "0".repeat(64)
    },
    generator: "operation.buildContextPack",
    sourceRefs: input.source_refs,
    content: input.content,
    ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
  });
}

function toContextPackArtifactId(taskId: string): string {
  return `context_pack.${taskId.toLowerCase()}`;
}

async function readExistingContextPackVersion(input: {
  artifact_dir?: string;
  task_id: string;
}): Promise<ArtifactVersion | undefined> {
  if (!input.artifact_dir) {
    return undefined;
  }

  try {
    const raw = await readFile(
      join(input.artifact_dir, CONTEXT_PACKS_DIR, `${input.task_id}.json`),
      "utf8"
    );
    const parsed = JSON.parse(raw) as Partial<ContextPackArtifact>;
    const version = parsed.metadata?.artifact_version;

    if (typeof version === "string" && /^v\d+$/.test(version)) {
      return version as ArtifactVersion;
    }

    throw new BuildContextPackError(
      "artifact_write_failed",
      "Existing context pack has invalid metadata.artifact_version."
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof BuildContextPackError) {
      throw error;
    }

    throw new BuildContextPackError(
      "artifact_write_failed",
      "Failed to read existing context pack metadata.",
      error
    );
  }
}

async function writeContextPackArtifact(input: {
  artifact_dir: string;
  task_id: string;
  context_pack: ContextPackArtifact;
}): Promise<void> {
  const directory = join(input.artifact_dir, CONTEXT_PACKS_DIR);

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${input.task_id}.json`),
      JSON.stringify(input.context_pack, null, 2),
      "utf8"
    );
  } catch (error) {
    throw new BuildContextPackError(
      "artifact_write_failed",
      "Failed writing context pack artifact.",
      error
    );
  }
}
