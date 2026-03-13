import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMetadata, ArtifactSourceRef, ArtifactVersion } from "../artifacts/types.js";
import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata
} from "../artifacts/versioning.js";
import type { ArtifactGate, ProjectMode } from "../contracts/domain.js";
import type { OperationContract } from "../contracts/operation.js";
import {
  IDEA_BUCKET_DEFINITIONS,
  type IdeaBriefArtifact,
  type IdeaBucketId,
  type IdeaInterviewUnresolvedAssumption
} from "./ideaInterview.js";

const PROPOSAL_SUMMARY_FILENAME = "proposal_summary.md";
const PROPOSAL_ISSUE_FILENAME = "proposal_issue.md";
const PROPOSAL_DISCUSSION_FILENAME = "proposal_discussion.md";
const IDEA_BRIEF_ALLOWED_STATUSES = ["approved", "accepted"] as const;

export const PROPOSAL_SUMMARY_SECTION_IDS = [
  "problem",
  "requested_change",
  "non_goals",
  "constraints_risks",
  "success_signal",
  "unresolved_assumptions"
] as const;

export type ProposalSummarySectionId = (typeof PROPOSAL_SUMMARY_SECTION_IDS)[number];
export type ProposalRepositoryOwnership = "owned" | "external";
export type ProposalDraftChannel = "issue" | "discussion";

type IdeaBriefAllowedStatus = (typeof IDEA_BRIEF_ALLOWED_STATUSES)[number];

export type GenerateProposalBriefErrorCode =
  | "insufficient_idea_brief"
  | "invalid_mode"
  | "artifact_write_failed";

export class GenerateProposalBriefError extends Error {
  readonly code: GenerateProposalBriefErrorCode;
  readonly details?: unknown;

  constructor(code: GenerateProposalBriefErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "GenerateProposalBriefError";
    this.code = code;
    this.details = details;
  }
}

export interface GenerateProposalBriefInput {
  project_mode: ProjectMode;
  idea_brief?: IdeaBriefArtifact;
  idea_brief_status?: string;
  repository_ownership: ProposalRepositoryOwnership;
  artifact_dir?: string;
  created_timestamp?: Date;
}

export interface ProposalSummaryArtifact {
  kind: "proposal_summary_markdown";
  metadata: ArtifactMetadata;
  source_refs: ArtifactSourceRef[];
  project_mode: "feature-proposal";
  repository_ownership: ProposalRepositoryOwnership;
  sections: Record<ProposalSummarySectionId, string>;
  content: string;
}

export interface ProposalDraftArtifact {
  kind: "proposal_issue_draft" | "proposal_discussion_draft";
  metadata: ArtifactMetadata;
  source_refs: ArtifactSourceRef[];
  project_mode: "feature-proposal";
  repository_ownership: ProposalRepositoryOwnership;
  path: string;
  content: string;
}

export interface ProposalWorkflowRoute {
  required_gate: ArtifactGate;
  repository_ownership: ProposalRepositoryOwnership;
  draft_channel: ProposalDraftChannel;
  next_step: "request_internal_proposal_approval" | "request_external_feedback";
}

export interface GenerateProposalBriefResult {
  proposal_summary: ProposalSummaryArtifact;
  proposal_draft: ProposalDraftArtifact;
  workflow: ProposalWorkflowRoute;
}

export const GENERATE_PROPOSAL_BRIEF_OPERATION_CONTRACT: OperationContract<
  GenerateProposalBriefInput,
  GenerateProposalBriefResult
> = {
  name: "operation.generateProposalBrief",
  version: "v1",
  purpose: "Generate deterministic proposal brief artifacts for feature-proposal workflows.",
  inputs_schema: {} as GenerateProposalBriefInput,
  outputs_schema: {} as GenerateProposalBriefResult,
  side_effects: ["writes proposal summary and ownership-aware handoff draft artifacts"],
  invariants: [
    "Only approved or accepted idea_brief inputs are used.",
    "Feature-proposal mode always routes through proposal_approval.",
    "Repository ownership changes the handoff channel without changing source-of-truth inputs."
  ],
  idempotency_expectations: [
    "Equivalent idea_brief and repository ownership inputs produce stable markdown structure."
  ],
  failure_modes: ["insufficient_idea_brief", "invalid_mode", "artifact_write_failed"],
  observability_fields: [
    "idea_brief_version",
    "repository_ownership",
    "draft_channel",
    "proposal_summary_version",
    "proposal_draft_version"
  ]
};

/**
 * Builds the feature-proposal approval packet from an approved idea_brief.
 *
 * The v1 branch point is intentionally narrow: repository ownership only affects
 * the handoff channel and follow-up instruction, while all proposal content stays
 * grounded in the same idea_brief buckets and unresolved assumptions.
 */
export async function runGenerateProposalBrief(
  input: GenerateProposalBriefInput
): Promise<GenerateProposalBriefResult> {
  if (input.project_mode !== "feature-proposal") {
    throw new GenerateProposalBriefError(
      "invalid_mode",
      "generateProposalBrief only supports feature-proposal mode."
    );
  }

  const ideaBrief = ensureIdeaBrief(input.idea_brief);
  ensureIdeaBriefStatus(input.idea_brief_status);

  if (ideaBrief.project_mode !== "feature-proposal") {
    throw new GenerateProposalBriefError(
      "invalid_mode",
      `idea_brief mode (${ideaBrief.project_mode}) does not match feature-proposal mode.`
    );
  }

  const workflow = buildProposalWorkflow(input.repository_ownership);
  const sections = buildProposalSummarySections(ideaBrief);
  const sourceRefs: ArtifactSourceRef[] = [
    {
      artifact_id: ideaBrief.metadata.artifact_id,
      artifact_version: ideaBrief.metadata.artifact_version
    }
  ];

  const summaryContent = renderProposalSummary(sections);
  const draftArtifactId =
    workflow.draft_channel === "issue" ? PROPOSAL_ISSUE_FILENAME : PROPOSAL_DISCUSSION_FILENAME;
  const draftPath = draftArtifactId;
  const draftContent = renderProposalDraft({
    sections,
    workflow,
    title: resolveBucketText(ideaBrief, "outcome")
  });

  const summaryPreviousVersion = await readExistingMarkdownVersion(
    input.artifact_dir,
    PROPOSAL_SUMMARY_FILENAME
  );
  const draftPreviousVersion = await readExistingMarkdownVersion(input.artifact_dir, draftArtifactId);

  const proposal_summary: ProposalSummaryArtifact = {
    kind: "proposal_summary_markdown",
    metadata: createProposalMetadata({
      artifact_id: PROPOSAL_SUMMARY_FILENAME,
      content: summaryContent,
      source_refs: sourceRefs,
      ...(summaryPreviousVersion ? { previous_version: summaryPreviousVersion } : {}),
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    }),
    source_refs: sourceRefs,
    project_mode: "feature-proposal",
    repository_ownership: input.repository_ownership,
    sections,
    content: summaryContent
  };

  const proposal_draft: ProposalDraftArtifact = {
    kind:
      workflow.draft_channel === "issue"
        ? "proposal_issue_draft"
        : "proposal_discussion_draft",
    metadata: createProposalMetadata({
      artifact_id: draftArtifactId,
      content: draftContent,
      source_refs: sourceRefs,
      ...(draftPreviousVersion ? { previous_version: draftPreviousVersion } : {}),
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    }),
    source_refs: sourceRefs,
    project_mode: "feature-proposal",
    repository_ownership: input.repository_ownership,
    path: draftPath,
    content: draftContent
  };

  if (input.artifact_dir) {
    await writeProposalArtifacts({
      artifact_dir: input.artifact_dir,
      proposal_summary,
      proposal_draft
    });
  }

  return {
    proposal_summary,
    proposal_draft,
    workflow
  };
}

function ensureIdeaBrief(ideaBrief?: IdeaBriefArtifact): IdeaBriefArtifact {
  if (!ideaBrief || ideaBrief.kind !== "idea_brief") {
    throw new GenerateProposalBriefError(
      "insufficient_idea_brief",
      "Missing or invalid idea_brief artifact."
    );
  }

  if (ideaBrief.metadata.artifact_id !== "idea_brief") {
    throw new GenerateProposalBriefError(
      "insufficient_idea_brief",
      "idea_brief artifact_id must be idea_brief."
    );
  }

  return ideaBrief;
}

function ensureIdeaBriefStatus(status?: string): asserts status is IdeaBriefAllowedStatus {
  if (!status || !IDEA_BRIEF_ALLOWED_STATUSES.includes(status as IdeaBriefAllowedStatus)) {
    throw new GenerateProposalBriefError(
      "insufficient_idea_brief",
      "idea_brief must be approved or accepted before proposal brief generation."
    );
  }
}

function buildProposalWorkflow(
  repositoryOwnership: ProposalRepositoryOwnership
): ProposalWorkflowRoute {
  // The workflow branch is explicit so later orchestration can consume it without
  // reverse-engineering repository intent from file names.
  if (repositoryOwnership === "owned") {
    return {
      required_gate: "proposal_approval",
      repository_ownership: repositoryOwnership,
      draft_channel: "issue",
      next_step: "request_internal_proposal_approval"
    };
  }

  return {
    required_gate: "proposal_approval",
    repository_ownership: repositoryOwnership,
    draft_channel: "discussion",
    next_step: "request_external_feedback"
  };
}

function buildProposalSummarySections(
  ideaBrief: IdeaBriefArtifact
): Record<ProposalSummarySectionId, string> {
  return {
    problem: [
      `Outcome: ${resolveBucketText(ideaBrief, "outcome")}`,
      `Users / Roles: ${resolveBucketText(ideaBrief, "users_roles")}`
    ].join("\n\n"),
    requested_change: [
      `Inputs: ${resolveBucketText(ideaBrief, "inputs")}`,
      `Outputs: ${resolveBucketText(ideaBrief, "outputs")}`,
      `Workflow: ${resolveBucketText(ideaBrief, "workflow")}`,
      `Interfaces: ${resolveBucketText(ideaBrief, "interfaces")}`
    ].join("\n\n"),
    non_goals: resolveBucketText(ideaBrief, "non_goals"),
    constraints_risks: [
      `Safety / Compliance: ${resolveBucketText(ideaBrief, "safety_compliance")}`,
      `Failure Modes: ${resolveBucketText(ideaBrief, "failure_modes")}`,
      `Operations: ${resolveBucketText(ideaBrief, "operations")}`
    ].join("\n\n"),
    success_signal: [
      `Quality Bar: ${resolveBucketText(ideaBrief, "quality_bar")}`,
      `Evaluation: ${resolveBucketText(ideaBrief, "evaluation")}`
    ].join("\n\n"),
    unresolved_assumptions: renderUnresolvedAssumptions(ideaBrief.unresolved_assumptions)
  };
}

function resolveBucketText(ideaBrief: IdeaBriefArtifact, bucketId: IdeaBucketId): string {
  const answer = normalizeText(ideaBrief.buckets[bucketId]);
  const unresolvedAssumption = ideaBrief.unresolved_assumptions.find(
    (entry) => entry.bucket_id === bucketId
  );

  if (answer.length === 0 && !unresolvedAssumption) {
    throw new GenerateProposalBriefError(
      "insufficient_idea_brief",
      `idea_brief is missing required bucket: ${bucketId}`
    );
  }

  if (answer.length === 0 && unresolvedAssumption) {
    return `Assumption: ${unresolvedAssumption.assumption}`;
  }

  if (answer.length > 0 && unresolvedAssumption) {
    return `${answer}\n\nAssumption: ${unresolvedAssumption.assumption}`;
  }

  return answer;
}

function renderUnresolvedAssumptions(
  unresolvedAssumptions: IdeaInterviewUnresolvedAssumption[]
): string {
  if (unresolvedAssumptions.length === 0) {
    return "None.";
  }

  const labelByBucketId = new Map(
    IDEA_BUCKET_DEFINITIONS.map((definition) => [definition.id, definition.label] as const)
  );

  return unresolvedAssumptions
    .map((entry) => `- ${labelByBucketId.get(entry.bucket_id) ?? entry.bucket_id}: ${entry.assumption}`)
    .join("\n");
}

function renderProposalSummary(
  sections: Record<ProposalSummarySectionId, string>
): string {
  const titleBySectionId: Record<ProposalSummarySectionId, string> = {
    problem: "Problem",
    requested_change: "Requested Change",
    non_goals: "Non-goals",
    constraints_risks: "Constraints and Risks",
    success_signal: "Success Signal",
    unresolved_assumptions: "Unresolved Assumptions"
  };

  const lines: string[] = ["# Proposal Summary", ""];

  for (const sectionId of PROPOSAL_SUMMARY_SECTION_IDS) {
    lines.push(`## ${titleBySectionId[sectionId]}`);
    lines.push(sections[sectionId]);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

interface RenderProposalDraftInput {
  sections: Record<ProposalSummarySectionId, string>;
  workflow: ProposalWorkflowRoute;
  title: string;
}

function renderProposalDraft(input: RenderProposalDraftInput): string {
  const lines =
    input.workflow.draft_channel === "issue"
      ? [
          "# Proposal Issue Draft",
          "",
          `Title: ${input.title}`,
          "",
          "## Problem",
          input.sections.problem,
          "",
          "## Requested Change",
          input.sections.requested_change,
          "",
          "## Non-goals",
          input.sections.non_goals,
          "",
          "## Constraints and Risks",
          input.sections.constraints_risks,
          "",
          "## Success Signal",
          input.sections.success_signal,
          "",
          "## Unresolved Assumptions",
          input.sections.unresolved_assumptions,
          "",
          "Please review this proposal before implementation begins."
        ]
      : [
          "# Proposal Discussion Draft",
          "",
          `Title: ${input.title}`,
          "",
          "I would like feedback before implementation.",
          "",
          "## Problem",
          input.sections.problem,
          "",
          "## Requested Change",
          input.sections.requested_change,
          "",
          "## Constraints and Risks",
          input.sections.constraints_risks,
          "",
          "## Success Signal",
          input.sections.success_signal,
          "",
          "## Unresolved Assumptions",
          input.sections.unresolved_assumptions
        ];

  return lines.join("\n").trimEnd();
}

interface CreateProposalMetadataInput {
  artifact_id: "proposal_summary.md" | "proposal_issue.md" | "proposal_discussion.md";
  previous_version?: ArtifactVersion;
  source_refs: ArtifactSourceRef[];
  content: string;
  created_timestamp?: Date;
}

function createProposalMetadata(input: CreateProposalMetadataInput): ArtifactMetadata {
  if (!input.previous_version) {
    return createInitialArtifactMetadata({
      artifactId: input.artifact_id,
      generator: "operation.generateProposalBrief",
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
      generator: "operation.generateProposalBrief",
      source_refs: input.source_refs,
      checksum: "0".repeat(64)
    },
    generator: "operation.generateProposalBrief",
    sourceRefs: input.source_refs,
    content: input.content,
    ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
  });
}

async function readExistingMarkdownVersion(
  artifactDir: string | undefined,
  fileName: string
): Promise<ArtifactVersion | undefined> {
  if (!artifactDir) {
    return undefined;
  }

  try {
    const raw = await readFile(join(artifactDir, fileName), "utf8");
    const metadataMatch = raw.match(/<!-- specforge:metadata=(.+) -->/);

    if (!metadataMatch || metadataMatch[1] === undefined) {
      throw new GenerateProposalBriefError(
        "artifact_write_failed",
        `Existing ${fileName} is missing embedded artifact metadata.`
      );
    }

    const metadata = JSON.parse(metadataMatch[1]) as Partial<ArtifactMetadata>;
    if (typeof metadata.artifact_version === "string" && /^v\d+$/.test(metadata.artifact_version)) {
      return metadata.artifact_version as ArtifactVersion;
    }

    throw new GenerateProposalBriefError(
      "artifact_write_failed",
      `Existing ${fileName} has invalid embedded artifact metadata.`
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof GenerateProposalBriefError) {
      throw error;
    }

    throw new GenerateProposalBriefError(
      "artifact_write_failed",
      `Unable to inspect existing ${fileName} artifact.`
    );
  }
}

interface WriteProposalArtifactsInput {
  artifact_dir: string;
  proposal_summary: ProposalSummaryArtifact;
  proposal_draft: ProposalDraftArtifact;
}

async function writeProposalArtifacts(input: WriteProposalArtifactsInput): Promise<void> {
  try {
    await mkdir(input.artifact_dir, { recursive: true });

    await writeFile(
      join(input.artifact_dir, PROPOSAL_SUMMARY_FILENAME),
      `${renderMarkdownWithMetadata(input.proposal_summary.content, input.proposal_summary.metadata)}\n`,
      "utf8"
    );

    await writeFile(
      join(input.artifact_dir, input.proposal_draft.path),
      `${renderMarkdownWithMetadata(input.proposal_draft.content, input.proposal_draft.metadata)}\n`,
      "utf8"
    );
  } catch {
    throw new GenerateProposalBriefError(
      "artifact_write_failed",
      "Failed to write proposal brief artifacts."
    );
  }
}

function renderMarkdownWithMetadata(content: string, metadata: ArtifactMetadata): string {
  // Markdown is the human-facing artifact, so the metadata is embedded as a single
  // comment to preserve version lineage without forcing a parallel JSON file in v1.
  return [content, "", `<!-- specforge:metadata=${JSON.stringify(metadata)} -->`].join("\n");
}

function normalizeText(value?: string): string {
  return (value ?? "").trim();
}
