import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMetadata, ArtifactSourceRef, ArtifactVersion } from "../artifacts/types.js";
import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata
} from "../artifacts/versioning.js";
import type { ProjectMode } from "../contracts/domain.js";
import type { OperationContract } from "../contracts/operation.js";
import type { PrdSectionId, SpecSectionId, ValidationIssue } from "../spec/contracts.js";
import { PRD_REQUIRED_SECTIONS, SPEC_REQUIRED_SECTIONS } from "../spec/contracts.js";
import { validateRequiredSections } from "../spec/validation.js";
import type { IdeaBriefArtifact } from "./ideaInterview.js";
import type { PrdJsonArtifact } from "./generatePRD.js";

const SPEC_MARKDOWN_FILENAME = "SPEC.md";
const SCHEMA_FILENAME = "core.schema.json";
const ACCEPTANCE_FILENAME = "core.md";
const DECISIONS_FILENAME = "decisions.md";
const INDEX_FILENAME = "index.json";
const DAG_FILENAME = "dag.yaml";

export type GenerateSpecPackErrorCode =
  | "insufficient_idea_brief"
  | "insufficient_prd"
  | "invalid_mode"
  | "artifact_write_failed";

export class GenerateSpecPackError extends Error {
  readonly code: GenerateSpecPackErrorCode;
  readonly details?: unknown;

  constructor(code: GenerateSpecPackErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "GenerateSpecPackError";
    this.code = code;
    this.details = details;
  }
}

export interface GenerateSpecPackInput {
  project_mode: ProjectMode;
  idea_brief?: IdeaBriefArtifact;
  prd_json?: PrdJsonArtifact;
  artifact_dir?: string;
  created_timestamp?: Date;
}

export interface SpecMarkdownArtifact {
  kind: "spec_markdown";
  metadata: ArtifactMetadata;
  source_refs: ArtifactSourceRef[];
  project_mode: ProjectMode;
  sections: Record<SpecSectionId, string>;
  content: string;
}

export interface SpecFileArtifact {
  kind: "schema_json" | "acceptance_markdown" | "decisions_markdown" | "dag_yaml";
  metadata: ArtifactMetadata;
  source_refs: ArtifactSourceRef[];
  path: string;
  content: string;
}

export interface SpecIndexEntry {
  artifact_id: string;
  artifact_version: ArtifactVersion;
  path: string;
  checksum: string;
  source_refs: ArtifactSourceRef[];
}

export interface SpecIndexArtifact {
  kind: "spec_index";
  metadata: ArtifactMetadata;
  source_refs: ArtifactSourceRef[];
  entries: SpecIndexEntry[];
}

export interface GenerateSpecPackResult {
  spec_artifact: {
    kind: "spec";
    metadata: ArtifactMetadata;
    sections: Record<SpecSectionId, string>;
    source_refs: ArtifactSourceRef[];
  };
  spec_md: SpecMarkdownArtifact;
  schema_artifact: SpecFileArtifact;
  acceptance_artifact: SpecFileArtifact;
  decisions_artifact: SpecFileArtifact;
  dag_artifact: SpecFileArtifact;
  spec_index: SpecIndexArtifact;
  validation_issues: ValidationIssue[];
}

export const GENERATE_SPEC_PACK_OPERATION_CONTRACT: OperationContract<
  GenerateSpecPackInput,
  GenerateSpecPackResult
> = {
  name: "operation.generateSpecPack",
  version: "v1",
  purpose: "Generate deterministic contract-first spec artifacts from idea_brief and PRD.",
  inputs_schema: {} as GenerateSpecPackInput,
  outputs_schema: {} as GenerateSpecPackResult,
  side_effects: ["writes SPEC.md, schema, acceptance, decisions, index, and initial DAG artifacts"],
  invariants: [
    "Spec pack output is deterministic for equivalent inputs.",
    "SPEC required sections are always validated.",
    "Artifacts reference exact source versions."
  ],
  idempotency_expectations: [
    "Generated section structure and index order are stable across runs."
  ],
  failure_modes: ["insufficient_idea_brief", "insufficient_prd", "invalid_mode", "artifact_write_failed"],
  observability_fields: [
    "project_mode",
    "idea_brief_version",
    "prd_version",
    "spec_version",
    "validation_issue_count"
  ]
};

export async function runGenerateSpecPack(
  input: GenerateSpecPackInput
): Promise<GenerateSpecPackResult> {
  const ideaBrief = ensureIdeaBrief(input.idea_brief);
  const prdJson = ensurePrdJson(input.prd_json);

  if (ideaBrief.project_mode !== input.project_mode || prdJson.project_mode !== input.project_mode) {
    throw new GenerateSpecPackError(
      "invalid_mode",
      "idea_brief/project_mode/prd_json mode mismatch."
    );
  }

  const sections = buildSpecSections(prdJson);
  const sourceRefs: ArtifactSourceRef[] = [
    {
      artifact_id: ideaBrief.metadata.artifact_id,
      artifact_version: ideaBrief.metadata.artifact_version
    },
    {
      artifact_id: prdJson.metadata.artifact_id,
      artifact_version: prdJson.metadata.artifact_version
    }
  ];

  const previousVersion = await readExistingSpecVersion(input.artifact_dir);
  const specMarkdownContent = renderSpecMarkdown(sections);

  // The in-memory spec contract and the markdown file are separate artifacts.
  // They share section content, but downstream planners expect the contract
  // artifact to retain the stable "spec.main" identifier.
  const specContractMetadata = createSpecMetadata({
    artifact_id: "spec.main",
    content: specMarkdownContent,
    source_refs: sourceRefs,
    ...(previousVersion ? { previous_version: previousVersion } : {}),
    ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
  });

  const spec_artifact = {
    kind: "spec" as const,
    metadata: specContractMetadata,
    sections,
    source_refs: sourceRefs
  };

  const validationIssues = validateRequiredSections(spec_artifact);
  if (validationIssues.length > 0) {
    throw new GenerateSpecPackError(
      "insufficient_prd",
      "Generated SPEC is missing required sections.",
      validationIssues
    );
  }

  const schemaContent = renderSchemaContent(prdJson);
  const acceptanceContent = renderAcceptanceContent(sections.acceptance_criteria);
  const decisionsContent = renderDecisionsContent(sections.decisions);
  const dagContent = renderInitialDag();

  const schemaArtifact: SpecFileArtifact = {
    kind: "schema_json",
    metadata: createSpecMetadata({
      artifact_id: "schema.core",
      content: schemaContent,
      source_refs: sourceRefs,
      ...(previousVersion ? { previous_version: previousVersion } : {}),
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    }),
    source_refs: sourceRefs,
    path: "schemas/core.schema.json",
    content: schemaContent
  };

  const acceptanceArtifact: SpecFileArtifact = {
    kind: "acceptance_markdown",
    metadata: createSpecMetadata({
      artifact_id: "acceptance.core",
      content: acceptanceContent,
      source_refs: sourceRefs,
      ...(previousVersion ? { previous_version: previousVersion } : {}),
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    }),
    source_refs: sourceRefs,
    path: "acceptance/core.md",
    content: acceptanceContent
  };

  const decisionsArtifact: SpecFileArtifact = {
    kind: "decisions_markdown",
    metadata: createSpecMetadata({
      artifact_id: "decisions.md",
      content: decisionsContent,
      source_refs: sourceRefs,
      ...(previousVersion ? { previous_version: previousVersion } : {}),
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    }),
    source_refs: sourceRefs,
    path: "decisions.md",
    content: decisionsContent
  };

  const dagArtifact: SpecFileArtifact = {
    kind: "dag_yaml",
    metadata: createSpecMetadata({
      artifact_id: "dag.yaml",
      content: dagContent,
      source_refs: sourceRefs,
      ...(previousVersion ? { previous_version: previousVersion } : {}),
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    }),
    source_refs: sourceRefs,
    path: "spec/dag.yaml",
    content: dagContent
  };

  const spec_md: SpecMarkdownArtifact = {
    kind: "spec_markdown",
    metadata: createSpecMetadata({
      artifact_id: "spec.md",
      content: specMarkdownContent,
      source_refs: sourceRefs,
      ...(previousVersion ? { previous_version: previousVersion } : {}),
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    }),
    source_refs: sourceRefs,
    project_mode: input.project_mode,
    sections,
    content: specMarkdownContent
  };

  const indexEntries: SpecIndexEntry[] = [
    {
      artifact_id: spec_md.metadata.artifact_id,
      artifact_version: spec_md.metadata.artifact_version,
      path: "SPEC.md",
      checksum: spec_md.metadata.checksum,
      source_refs: sourceRefs
    },
    {
      artifact_id: schemaArtifact.metadata.artifact_id,
      artifact_version: schemaArtifact.metadata.artifact_version,
      path: schemaArtifact.path,
      checksum: schemaArtifact.metadata.checksum,
      source_refs: sourceRefs
    },
    {
      artifact_id: acceptanceArtifact.metadata.artifact_id,
      artifact_version: acceptanceArtifact.metadata.artifact_version,
      path: acceptanceArtifact.path,
      checksum: acceptanceArtifact.metadata.checksum,
      source_refs: sourceRefs
    },
    {
      artifact_id: decisionsArtifact.metadata.artifact_id,
      artifact_version: decisionsArtifact.metadata.artifact_version,
      path: decisionsArtifact.path,
      checksum: decisionsArtifact.metadata.checksum,
      source_refs: sourceRefs
    },
    {
      artifact_id: dagArtifact.metadata.artifact_id,
      artifact_version: dagArtifact.metadata.artifact_version,
      path: dagArtifact.path,
      checksum: dagArtifact.metadata.checksum,
      source_refs: sourceRefs
    }
  ];

  const specIndexContent = JSON.stringify({ entries: indexEntries }, null, 2);
  const spec_index: SpecIndexArtifact = {
    kind: "spec_index",
    metadata: createSpecMetadata({
      artifact_id: "spec.index",
      content: specIndexContent,
      source_refs: sourceRefs,
      ...(previousVersion ? { previous_version: previousVersion } : {}),
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    }),
    source_refs: sourceRefs,
    entries: indexEntries
  };

  if (input.artifact_dir) {
    await writeSpecPackArtifacts({
      artifact_dir: input.artifact_dir,
      spec_md,
      schema_artifact: schemaArtifact,
      acceptance_artifact: acceptanceArtifact,
      decisions_artifact: decisionsArtifact,
      dag_artifact: dagArtifact,
      spec_index
    });
  }

  return {
    spec_artifact,
    spec_md,
    schema_artifact: schemaArtifact,
    acceptance_artifact: acceptanceArtifact,
    decisions_artifact: decisionsArtifact,
    dag_artifact: dagArtifact,
    spec_index,
    validation_issues: validationIssues
  };
}

function ensureIdeaBrief(artifact?: IdeaBriefArtifact): IdeaBriefArtifact {
  if (!artifact || artifact.kind !== "idea_brief") {
    throw new GenerateSpecPackError("insufficient_idea_brief", "Missing or invalid idea_brief artifact.");
  }

  if (artifact.metadata.artifact_id !== "idea_brief") {
    throw new GenerateSpecPackError("insufficient_idea_brief", "idea_brief artifact_id must be idea_brief.");
  }

  return artifact;
}

function ensurePrdJson(artifact?: PrdJsonArtifact): PrdJsonArtifact {
  if (!artifact || artifact.kind !== "prd_json") {
    throw new GenerateSpecPackError("insufficient_prd", "Missing or invalid prd_json artifact.");
  }

  if (artifact.metadata.artifact_id !== "prd.json") {
    throw new GenerateSpecPackError("insufficient_prd", "prd_json artifact_id must be prd.json.");
  }

  for (const sectionId of PRD_REQUIRED_SECTIONS) {
    const value = normalizeText(artifact.sections[sectionId]);
    if (value.length === 0) {
      throw new GenerateSpecPackError("insufficient_prd", `PRD section is missing: ${sectionId}`);
    }
  }

  return artifact;
}

function buildSpecSections(prd: PrdJsonArtifact): Record<SpecSectionId, string> {
  return {
    summary: prd.sections.outcome,
    scope:
      `Users/Roles: ${prd.sections.users_roles}\n\n` +
      `Non-goals: ${prd.sections.non_goals}`,
    contracts:
      `Interfaces: ${prd.sections.interfaces}\n\n` +
      `Inputs: ${prd.sections.inputs}\n\n` +
      `Outputs: ${prd.sections.outputs}`,
    acceptance_criteria:
      `Evaluation: ${prd.sections.evaluation}\n\n` +
      `Quality Bar: ${prd.sections.quality_bar}`,
    decisions:
      `Failure Modes: ${prd.sections.failure_modes}\n\n` +
      `Operations: ${prd.sections.operations}`,
    work_graph: "See spec/dag.yaml for the initial EPIC/STORY/TASK work graph."
  };
}

function renderSpecMarkdown(sections: Record<SpecSectionId, string>): string {
  const titleBySection: Record<SpecSectionId, string> = {
    summary: "Summary",
    scope: "Scope",
    contracts: "Contracts",
    acceptance_criteria: "Acceptance Criteria",
    decisions: "Decisions",
    work_graph: "Work Graph"
  };

  const lines: string[] = ["# Specification", ""];

  for (const sectionId of SPEC_REQUIRED_SECTIONS) {
    lines.push(`## ${titleBySection[sectionId]}`);
    lines.push(sections[sectionId]);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function renderSchemaContent(prd: PrdJsonArtifact): string {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "SpecForgeCoreContract",
    type: "object",
    additionalProperties: false,
    required: ["inputs", "outputs"],
    properties: {
      inputs: {
        type: "string",
        description: prd.sections.inputs
      },
      outputs: {
        type: "string",
        description: prd.sections.outputs
      }
    }
  };

  return JSON.stringify(schema, null, 2);
}

function renderAcceptanceContent(acceptanceCriteriaSection: string): string {
  // Downstream planners and context packs rely on stable AC-* identifiers.
  // We normalize the acceptance section into canonical bullets here so the
  // generated acceptance artifact stays machine-addressable across operations.
  const criteria = collectAcceptanceCriteria(acceptanceCriteriaSection);
  const bulletLines = (criteria.length > 0 ? criteria : ["Satisfy acceptance criteria."]).map(
    (criterion, index) => `- AC-${index + 1}: ${criterion}`
  );

  return ["# Acceptance Criteria", "", ...bulletLines].join("\n");
}

function collectAcceptanceCriteria(section: string): string[] {
  const criteria: string[] = [];
  let currentCriterion = "";

  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flushCriterion(criteria, currentCriterion);
      currentCriterion = "";
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    if (startsNewCriterion(line) && currentCriterion.length > 0) {
      flushCriterion(criteria, currentCriterion);
      currentCriterion = "";
    }

    currentCriterion = currentCriterion.length === 0 ? line : `${currentCriterion} ${line}`;
  }

  flushCriterion(criteria, currentCriterion);
  return criteria;
}

function flushCriterion(criteria: string[], value: string): void {
  const normalized = normalizeAcceptanceCriterion(value);
  if (normalized.length > 0) {
    criteria.push(normalized);
  }
}

function startsNewCriterion(line: string): boolean {
  return /^(?:[-*+]|[0-9]+[.)])\s+/.test(line) || /^AC-\d+:\s*/i.test(line);
}

function normalizeAcceptanceCriterion(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "";
  }

  const labeledMatch = normalized.match(/^(Evaluation:|Quality Bar:)\s*(.*)$/i);
  if (labeledMatch) {
    const label = labeledMatch[1] ?? "";
    const rest = labeledMatch[2] ?? "";
    const normalizedRest = stripRepeatedSectionLabel(stripAcceptanceDecorators(rest), label);
    return normalizedRest.length > 0 ? `${label} ${normalizedRest}` : label;
  }

  return stripAcceptanceDecorators(normalized);
}

function stripAcceptanceDecorators(value: string): string {
  return value
    .replace(/^(?:[-*+]|[0-9]+[.)])\s+/, "")
    .replace(/^AC-\d+:\s*/i, "")
    .trim();
}

function stripRepeatedSectionLabel(value: string, label: string): string {
  const labelPattern = new RegExp(`^${escapeRegExp(label)}\\s*`, "i");
  return value.replace(labelPattern, "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderDecisionsContent(decisionsSection: string): string {
  return ["# Decisions", "", decisionsSection].join("\n");
}

function renderInitialDag(): string {
  return [
    "epics:",
    "  - id: EPIC-1",
    "    title: Deliver initial spec artifacts",
    "    stories:",
    "      - id: STORY-1",
    "        title: Validate contracts and acceptance artifacts",
    "        tasks:",
    "          - id: TASK-1",
    "            title: Verify schema and acceptance coverage",
    "            acceptance_ref: acceptance/core.md",
    "            contract_ref: schemas/core.schema.json"
  ].join("\n");
}

interface CreateSpecMetadataInput {
  artifact_id:
    | "spec.main"
    | "spec.md"
    | "schema.core"
    | "acceptance.core"
    | "decisions.md"
    | "spec.index"
    | "dag.yaml";
  content: string;
  source_refs: ArtifactSourceRef[];
  previous_version?: ArtifactVersion;
  created_timestamp?: Date;
}

function createSpecMetadata(input: CreateSpecMetadataInput): ArtifactMetadata {
  if (!input.previous_version) {
    return createInitialArtifactMetadata({
      artifactId: input.artifact_id,
      generator: "operation.generateSpecPack",
      sourceRefs: input.source_refs,
      content: input.content,
      ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
    });
  }

  return createNextArtifactMetadata({
    previous: {
      artifact_id: input.artifact_id,
      artifact_version: input.previous_version,
      created_timestamp: "1970-01-01T00:00:00.000Z",
      generator: "operation.generateSpecPack",
      source_refs: input.source_refs,
      checksum: "0".repeat(64)
    },
    generator: "operation.generateSpecPack",
    sourceRefs: input.source_refs,
    content: input.content,
    ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
  });
}

async function readExistingSpecVersion(artifactDir?: string): Promise<ArtifactVersion | undefined> {
  if (!artifactDir) {
    return undefined;
  }

  try {
    const raw = await readFile(join(artifactDir, "spec", INDEX_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<SpecIndexArtifact>;
    const version = parsed.metadata?.artifact_version;

    if (typeof version === "string" && /^v\d+$/.test(version)) {
      return version as ArtifactVersion;
    }

    throw new GenerateSpecPackError(
      "artifact_write_failed",
      "Existing spec/index.json has invalid metadata.artifact_version."
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof GenerateSpecPackError) {
      throw error;
    }

    throw new GenerateSpecPackError(
      "artifact_write_failed",
      "Unable to inspect existing spec/index.json artifact."
    );
  }
}

interface WriteSpecPackArtifactsInput {
  artifact_dir: string;
  spec_md: SpecMarkdownArtifact;
  schema_artifact: SpecFileArtifact;
  acceptance_artifact: SpecFileArtifact;
  decisions_artifact: SpecFileArtifact;
  dag_artifact: SpecFileArtifact;
  spec_index: SpecIndexArtifact;
}

async function writeSpecPackArtifacts(input: WriteSpecPackArtifactsInput): Promise<void> {
  try {
    await mkdir(join(input.artifact_dir, "schemas"), { recursive: true });
    await mkdir(join(input.artifact_dir, "acceptance"), { recursive: true });
    await mkdir(join(input.artifact_dir, "spec"), { recursive: true });

    await writeFile(join(input.artifact_dir, SPEC_MARKDOWN_FILENAME), `${input.spec_md.content}\n`, "utf8");
    await writeFile(
      join(input.artifact_dir, "schemas", SCHEMA_FILENAME),
      `${input.schema_artifact.content}\n`,
      "utf8"
    );
    await writeFile(
      join(input.artifact_dir, "acceptance", ACCEPTANCE_FILENAME),
      `${input.acceptance_artifact.content}\n`,
      "utf8"
    );
    await writeFile(
      join(input.artifact_dir, DECISIONS_FILENAME),
      `${input.decisions_artifact.content}\n`,
      "utf8"
    );
    await writeFile(
      join(input.artifact_dir, "spec", DAG_FILENAME),
      `${input.dag_artifact.content}\n`,
      "utf8"
    );
    await writeFile(
      join(input.artifact_dir, "spec", INDEX_FILENAME),
      `${JSON.stringify(input.spec_index, null, 2)}\n`,
      "utf8"
    );
  } catch {
    throw new GenerateSpecPackError("artifact_write_failed", "Failed to write spec pack artifacts.");
  }
}

function normalizeText(value?: string): string {
  return (value ?? "").trim();
}
