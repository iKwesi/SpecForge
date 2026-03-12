import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMetadata, ArtifactSourceRef, ArtifactVersion } from "../artifacts/types.js";
import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata
} from "../artifacts/versioning.js";
import type { ProjectMode } from "../contracts/domain.js";
import type { OperationContract } from "../contracts/operation.js";
import type { PrdSectionId, ValidationIssue } from "../spec/contracts.js";
import { PRD_REQUIRED_SECTIONS } from "../spec/contracts.js";
import { validateRequiredSections } from "../spec/validation.js";
import {
  IDEA_BUCKET_DEFINITIONS,
  type IdeaBriefArtifact,
  type IdeaInterviewUnresolvedAssumption
} from "./ideaInterview.js";

const PRD_MARKDOWN_FILENAME = "PRD.md";
const PRD_JSON_FILENAME = "PRD.json";

const IDEA_BRIEF_ALLOWED_STATUSES = ["approved", "accepted"] as const;
type IdeaBriefAllowedStatus = (typeof IDEA_BRIEF_ALLOWED_STATUSES)[number];

export type GeneratePrdErrorCode =
  | "insufficient_idea_brief"
  | "invalid_mode"
  | "artifact_write_failed";

export class GeneratePrdError extends Error {
  readonly code: GeneratePrdErrorCode;
  readonly details?: unknown;

  constructor(code: GeneratePrdErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "GeneratePrdError";
    this.code = code;
    this.details = details;
  }
}

export interface GeneratePrdInput {
  project_mode: ProjectMode;
  idea_brief?: IdeaBriefArtifact;
  idea_brief_status?: string;
  artifact_dir?: string;
  created_timestamp?: Date;
}

export interface PrdMarkdownArtifact {
  kind: "prd_markdown";
  metadata: ArtifactMetadata;
  source_refs: ArtifactSourceRef[];
  project_mode: ProjectMode;
  sections: Record<PrdSectionId, string>;
  content: string;
}

export interface PrdJsonArtifact {
  kind: "prd_json";
  metadata: ArtifactMetadata;
  source_refs: ArtifactSourceRef[];
  project_mode: ProjectMode;
  sections: Record<PrdSectionId, string>;
  unresolved_assumptions: IdeaInterviewUnresolvedAssumption[];
}

export interface GeneratePrdResult {
  prd_md: PrdMarkdownArtifact;
  prd_json: PrdJsonArtifact;
  validation_issues: ValidationIssue[];
}

export const GENERATE_PRD_OPERATION_CONTRACT: OperationContract<GeneratePrdInput, GeneratePrdResult> = {
  name: "operation.generatePRD",
  version: "v1",
  purpose: "Generate PRD artifacts from an approved or accepted idea brief.",
  inputs_schema: {} as GeneratePrdInput,
  outputs_schema: {} as GeneratePrdResult,
  side_effects: ["writes PRD.md and PRD.json artifacts"],
  invariants: [
    "PRD reflects idea_brief buckets and unresolved assumptions only.",
    "PRD required sections are deterministic and complete.",
    "Input idea_brief must be approved or accepted before generation."
  ],
  idempotency_expectations: [
    "For identical inputs and prior artifact version state, output sections are deterministic."
  ],
  failure_modes: ["insufficient_idea_brief", "invalid_mode", "artifact_write_failed"],
  observability_fields: [
    "project_mode",
    "idea_brief_version",
    "prd_json_version",
    "required_section_count",
    "unresolved_assumption_count"
  ]
};

export async function runGeneratePrd(input: GeneratePrdInput): Promise<GeneratePrdResult> {
  const ideaBrief = ensureIdeaBrief(input.idea_brief);
  ensureIdeaBriefStatus(input.idea_brief_status);

  if (ideaBrief.project_mode !== input.project_mode) {
    throw new GeneratePrdError(
      "invalid_mode",
      `idea_brief mode (${ideaBrief.project_mode}) does not match requested mode (${input.project_mode}).`
    );
  }

  const sections = buildPrdSections(ideaBrief);
  const sourceRefs: ArtifactSourceRef[] = [
    {
      artifact_id: ideaBrief.metadata.artifact_id,
      artifact_version: ideaBrief.metadata.artifact_version
    }
  ];

  const previousVersion = await readExistingPrdVersion(input.artifact_dir);

  const jsonMetadata = createPrdMetadata({
    artifact_id: "prd.json",
    source_refs: sourceRefs,
    content: JSON.stringify(sections),
    ...(previousVersion ? { previous_version: previousVersion } : {}),
    ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
  });

  const markdownContent = renderPrdMarkdown(sections);
  const markdownMetadata = createPrdMetadata({
    artifact_id: "prd.md",
    source_refs: sourceRefs,
    content: markdownContent,
    ...(previousVersion ? { previous_version: previousVersion } : {}),
    ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
  });

  const prd_json: PrdJsonArtifact = {
    kind: "prd_json",
    metadata: jsonMetadata,
    source_refs: sourceRefs,
    project_mode: input.project_mode,
    sections,
    unresolved_assumptions: [...ideaBrief.unresolved_assumptions]
  };

  const prd_md: PrdMarkdownArtifact = {
    kind: "prd_markdown",
    metadata: markdownMetadata,
    source_refs: sourceRefs,
    project_mode: input.project_mode,
    sections,
    content: markdownContent
  };

  const validationIssues = validateRequiredSections({
    kind: "prd",
    metadata: prd_json.metadata,
    sections: prd_json.sections,
    source_refs: prd_json.source_refs
  });

  if (validationIssues.length > 0) {
    throw new GeneratePrdError(
      "insufficient_idea_brief",
      "Generated PRD is missing required sections.",
      validationIssues
    );
  }

  if (input.artifact_dir) {
    await writePrdArtifacts({
      artifact_dir: input.artifact_dir,
      prd_md,
      prd_json
    });
  }

  return {
    prd_md,
    prd_json,
    validation_issues: validationIssues
  };
}

function ensureIdeaBrief(ideaBrief?: IdeaBriefArtifact): IdeaBriefArtifact {
  if (!ideaBrief || ideaBrief.kind !== "idea_brief") {
    throw new GeneratePrdError("insufficient_idea_brief", "Missing or invalid idea_brief artifact.");
  }

  if (ideaBrief.metadata.artifact_id !== "idea_brief") {
    throw new GeneratePrdError("insufficient_idea_brief", "idea_brief artifact_id must be idea_brief.");
  }

  return ideaBrief;
}

function ensureIdeaBriefStatus(status?: string): asserts status is IdeaBriefAllowedStatus {
  if (!status || !IDEA_BRIEF_ALLOWED_STATUSES.includes(status as IdeaBriefAllowedStatus)) {
    throw new GeneratePrdError(
      "insufficient_idea_brief",
      "idea_brief must be approved or accepted before PRD generation."
    );
  }
}

function buildPrdSections(ideaBrief: IdeaBriefArtifact): Record<PrdSectionId, string> {
  const sections = {} as Record<PrdSectionId, string>;

  for (const sectionId of PRD_REQUIRED_SECTIONS) {
    const answer = normalizeText(ideaBrief.buckets[sectionId]);
    const unresolvedAssumption = ideaBrief.unresolved_assumptions.find(
      (entry) => entry.bucket_id === sectionId
    );

    if (answer.length === 0 && !unresolvedAssumption) {
      throw new GeneratePrdError(
        "insufficient_idea_brief",
        `idea_brief is missing required bucket: ${sectionId}`
      );
    }

    if (answer.length === 0 && unresolvedAssumption) {
      sections[sectionId] = `Assumption: ${unresolvedAssumption.assumption}`;
      continue;
    }

    if (answer.length > 0 && unresolvedAssumption) {
      sections[sectionId] =
        `${answer}\n\n` + `Assumption: ${unresolvedAssumption.assumption}`;
      continue;
    }

    sections[sectionId] = answer;
  }

  return sections;
}

function renderPrdMarkdown(sections: Record<PrdSectionId, string>): string {
  const sectionTitleById = new Map(
    IDEA_BUCKET_DEFINITIONS.map((definition) => [definition.id, definition.label] as const)
  );

  const lines: string[] = ["# Product Requirements Document", ""];

  for (const sectionId of PRD_REQUIRED_SECTIONS) {
    const heading = sectionTitleById.get(sectionId) ?? sectionId;
    lines.push(`## ${heading}`);
    lines.push(sections[sectionId]);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

interface CreatePrdMetadataInput {
  artifact_id: "prd.md" | "prd.json";
  previous_version?: ArtifactVersion;
  source_refs: ArtifactSourceRef[];
  content: string;
  created_timestamp?: Date;
}

function createPrdMetadata(input: CreatePrdMetadataInput): ArtifactMetadata {
  if (!input.previous_version) {
    return createInitialArtifactMetadata({
      artifactId: input.artifact_id,
      generator: "operation.generatePRD",
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
      generator: "operation.generatePRD",
      source_refs: input.source_refs,
      checksum: "0".repeat(64)
    },
    generator: "operation.generatePRD",
    sourceRefs: input.source_refs,
    content: input.content,
    ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
  });
}

async function readExistingPrdVersion(
  artifactDir?: string
): Promise<ArtifactVersion | undefined> {
  if (!artifactDir) {
    return undefined;
  }

  try {
    const raw = await readFile(join(artifactDir, PRD_JSON_FILENAME), { encoding: "utf8" });
    const parsed = JSON.parse(raw) as Partial<PrdJsonArtifact>;
    const existingVersion = parsed.metadata?.artifact_version;

    if (typeof existingVersion === "string" && /^v\d+$/.test(existingVersion)) {
      return existingVersion as ArtifactVersion;
    }

    throw new GeneratePrdError(
      "artifact_write_failed",
      "Existing PRD.json has invalid metadata.artifact_version."
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof GeneratePrdError) {
      throw error;
    }

    throw new GeneratePrdError("artifact_write_failed", "Unable to inspect existing PRD artifact.");
  }
}

interface WritePrdArtifactsInput {
  artifact_dir: string;
  prd_md: PrdMarkdownArtifact;
  prd_json: PrdJsonArtifact;
}

async function writePrdArtifacts(input: WritePrdArtifactsInput): Promise<void> {
  try {
    await mkdir(input.artifact_dir, { recursive: true });
    await writeFile(join(input.artifact_dir, PRD_MARKDOWN_FILENAME), `${input.prd_md.content}\n`, "utf8");
    await writeFile(
      join(input.artifact_dir, PRD_JSON_FILENAME),
      `${JSON.stringify(input.prd_json, null, 2)}\n`,
      "utf8"
    );
  } catch {
    throw new GeneratePrdError("artifact_write_failed", "Failed to write PRD artifacts.");
  }
}

function normalizeText(value?: string): string {
  return (value ?? "").trim();
}
