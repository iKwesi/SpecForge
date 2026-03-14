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
import type { SpecArtifactContract } from "../spec/contracts.js";
import type { PrdJsonArtifact } from "./generatePRD.js";

const DAG_FILENAME = "dag.yaml";

export type DecomposeToWorkGraphErrorCode =
  | "invalid_mode"
  | "insufficient_prd"
  | "insufficient_spec"
  | "insufficient_acceptance"
  | "insufficient_contracts"
  | "artifact_write_failed";

export class DecomposeToWorkGraphError extends Error {
  readonly code: DecomposeToWorkGraphErrorCode;
  readonly details?: unknown;

  constructor(code: DecomposeToWorkGraphErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DecomposeToWorkGraphError";
    this.code = code;
    this.details = details;
  }
}

export interface AcceptanceArtifactInput {
  kind: "acceptance_markdown";
  metadata: ArtifactMetadata;
  source_refs: ArtifactSourceRef[];
  path: string;
  content: string;
}

export interface SchemaArtifactInput {
  kind: "schema_json";
  metadata: ArtifactMetadata;
  source_refs: ArtifactSourceRef[];
  path: string;
  content: string;
}

export interface DecomposeToWorkGraphInput {
  project_mode: ProjectMode;
  prd_json?: PrdJsonArtifact;
  spec_artifact?: SpecArtifactContract;
  acceptance_artifact?: AcceptanceArtifactInput;
  schema_artifact?: SchemaArtifactInput;
  artifact_dir?: string;
  created_timestamp?: Date;
}

export interface WorkGraphTask {
  id: string;
  title: string;
  acceptance_refs: string[];
  contract_refs: string[];
  depends_on: string[];
}

export interface WorkGraphStory {
  id: string;
  title: string;
  tasks: WorkGraphTask[];
}

export interface WorkGraphEpic {
  id: string;
  title: string;
  stories: WorkGraphStory[];
}

export interface WorkGraph {
  epics: WorkGraphEpic[];
}

export interface DagArtifact {
  kind: "dag_yaml";
  metadata: ArtifactMetadata;
  source_refs: ArtifactSourceRef[];
  path: "spec/dag.yaml";
  content: string;
}

export interface DecomposeToWorkGraphResult {
  dag_artifact: DagArtifact;
  work_graph: WorkGraph;
}

export const DECOMPOSE_TO_WORK_GRAPH_OPERATION_CONTRACT: OperationContract<
  DecomposeToWorkGraphInput,
  DecomposeToWorkGraphResult
> = {
  name: "operation.decomposeToWorkGraph",
  version: "v1",
  purpose: "Derive deterministic EPIC/STORY/TASK dag artifacts from PRD, SPEC, acceptance, and contract artifacts.",
  inputs_schema: {} as DecomposeToWorkGraphInput,
  outputs_schema: {} as DecomposeToWorkGraphResult,
  side_effects: ["writes spec/dag.yaml"],
  invariants: [
    "DAG tasks reference acceptance criteria and contracts.",
    "Graph decomposition is deterministic for equivalent input artifacts.",
    "Published DAG artifact metadata is versioned and immutable per run."
  ],
  idempotency_expectations: [
    "Equivalent inputs produce stable task ordering and dependency structure."
  ],
  failure_modes: [
    "invalid_mode",
    "insufficient_prd",
    "insufficient_spec",
    "insufficient_acceptance",
    "insufficient_contracts",
    "artifact_write_failed"
  ],
  observability_fields: [
    "project_mode",
    "prd_version",
    "spec_version",
    "dag_version",
    "task_count"
  ]
};

export async function runDecomposeToWorkGraph(
  input: DecomposeToWorkGraphInput
): Promise<DecomposeToWorkGraphResult> {
  if (input.project_mode !== "existing-repo") {
    throw new DecomposeToWorkGraphError(
      "invalid_mode",
      "decomposeToWorkGraph currently supports project_mode=existing-repo."
    );
  }

  const prdJson = ensurePrdJson(input.prd_json);
  const specArtifact = ensureSpecArtifact(input.spec_artifact);
  const acceptanceArtifact = ensureAcceptanceArtifact(input.acceptance_artifact);
  const schemaArtifact = ensureSchemaArtifact(input.schema_artifact);

  if (prdJson.project_mode !== input.project_mode) {
    throw new DecomposeToWorkGraphError(
      "invalid_mode",
      "prd_json project_mode does not match requested mode."
    );
  }

  const acceptanceCriteria = extractAcceptanceCriteria(acceptanceArtifact.content);
  const contractRefs = buildContractRefs(schemaArtifact.path);
  const graph = buildWorkGraph({
    prd_json: prdJson,
    spec_artifact: specArtifact,
    acceptance_criteria: acceptanceCriteria,
    contract_refs: contractRefs
  });

  const sourceRefs = buildSourceRefs([
    prdJson.metadata,
    specArtifact.metadata,
    acceptanceArtifact.metadata,
    schemaArtifact.metadata
  ]);

  const previousVersion = await readExistingDagVersion(input.artifact_dir);
  const dagVersion = deriveArtifactVersion(previousVersion);
  const dagContent = renderDagYaml({
    version: dagVersion,
    graph
  });

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
    await writeDagArtifact(input.artifact_dir, dagArtifact.content);
  }

  return {
    dag_artifact: dagArtifact,
    work_graph: graph
  };
}

function ensurePrdJson(artifact?: PrdJsonArtifact): PrdJsonArtifact {
  if (!artifact || artifact.kind !== "prd_json") {
    throw new DecomposeToWorkGraphError("insufficient_prd", "Missing or invalid prd_json artifact.");
  }

  if (artifact.metadata.artifact_id !== "prd.json") {
    throw new DecomposeToWorkGraphError("insufficient_prd", "prd_json artifact_id must be prd.json.");
  }

  return artifact;
}

function ensureSpecArtifact(artifact?: SpecArtifactContract): SpecArtifactContract {
  if (!artifact || artifact.kind !== "spec") {
    throw new DecomposeToWorkGraphError("insufficient_spec", "Missing or invalid spec artifact.");
  }

  if (!artifact.metadata.artifact_id.startsWith("spec.")) {
    throw new DecomposeToWorkGraphError(
      "insufficient_spec",
      "spec artifact metadata.artifact_id must start with spec."
    );
  }

  return artifact;
}

function ensureAcceptanceArtifact(artifact?: AcceptanceArtifactInput): AcceptanceArtifactInput {
  if (!artifact || artifact.kind !== "acceptance_markdown") {
    throw new DecomposeToWorkGraphError(
      "insufficient_acceptance",
      "Missing or invalid acceptance artifact."
    );
  }

  if (artifact.path.trim().length === 0 || artifact.content.trim().length === 0) {
    throw new DecomposeToWorkGraphError(
      "insufficient_acceptance",
      "acceptance artifact path/content must be non-empty."
    );
  }

  return artifact;
}

function ensureSchemaArtifact(artifact?: SchemaArtifactInput): SchemaArtifactInput {
  if (!artifact || artifact.kind !== "schema_json") {
    throw new DecomposeToWorkGraphError(
      "insufficient_contracts",
      "Missing or invalid schema artifact."
    );
  }

  if (artifact.path.trim().length === 0 || artifact.content.trim().length === 0) {
    throw new DecomposeToWorkGraphError(
      "insufficient_contracts",
      "schema artifact path/content must be non-empty."
    );
  }

  return artifact;
}

interface AcceptanceCriterion {
  id: string;
  text: string;
}

function extractAcceptanceCriteria(content: string): AcceptanceCriterion[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const bulletItems = lines
    .filter((line) => line.startsWith("- "))
    .map((line) => stripAcceptanceIdPrefix(line.slice(2).trim()))
    .filter((line) => line.length > 0);

  const criteriaText = bulletItems.length > 0
    ? bulletItems
    : lines.map((line) => stripAcceptanceIdPrefix(line.trim())).filter((line) => line.length > 0);

  if (criteriaText.length === 0) {
    return [{ id: "AC-1", text: "Satisfy acceptance criteria." }];
  }

  return criteriaText.map((text, index) => ({
    id: `AC-${index + 1}`,
    text
  }));
}

function stripAcceptanceIdPrefix(value: string): string {
  return value.replace(/^AC-\d+:\s*/i, "").trim();
}

function buildContractRefs(schemaPath: string): string[] {
  return [...new Set([schemaPath.trim(), "spec.contracts"])]
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

interface BuildWorkGraphInput {
  prd_json: PrdJsonArtifact;
  spec_artifact: SpecArtifactContract;
  acceptance_criteria: AcceptanceCriterion[];
  contract_refs: string[];
}

function buildWorkGraph(input: BuildWorkGraphInput): WorkGraph {
  const tasks: WorkGraphTask[] = input.acceptance_criteria.map((criterion, index) => {
    const taskId = `TASK-${index + 1}`;
    const dependsOn = index === 0 ? [] : [`TASK-${index}`];

    return {
      id: taskId,
      title: `Satisfy ${criterion.id}: ${truncateText(criterion.text, 88)}`,
      acceptance_refs: [criterion.id],
      contract_refs: [...input.contract_refs],
      depends_on: dependsOn
    };
  });

  return {
    epics: [
      {
        id: "EPIC-1",
        title: truncateText(
          input.spec_artifact.sections.summary ?? input.prd_json.sections.outcome,
          96
        ),
        stories: [
          {
            id: "STORY-1",
            title: truncateText(input.prd_json.sections.workflow, 96),
            tasks
          }
        ]
      }
    ]
  };
}

function truncateText(value: string | undefined, maxLength: number): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "Untitled";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function buildSourceRefs(metadataList: ArtifactMetadata[]): ArtifactSourceRef[] {
  const refs: ArtifactSourceRef[] = metadataList.map((metadata) => ({
    artifact_id: metadata.artifact_id,
    artifact_version: metadata.artifact_version
  }));

  const deduped = new Map<string, ArtifactSourceRef>();
  for (const ref of refs) {
    const key = `${ref.artifact_id}@${ref.artifact_version}`;
    deduped.set(key, ref);
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
      generator: "operation.decomposeToWorkGraph",
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
      generator: "operation.decomposeToWorkGraph",
      source_refs: input.source_refs,
      checksum: "0".repeat(64)
    },
    generator: "operation.decomposeToWorkGraph",
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

    throw new DecomposeToWorkGraphError(
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
    throw new DecomposeToWorkGraphError(
      "artifact_write_failed",
      "Failed writing dag.yaml artifact.",
      error
    );
  }
}
