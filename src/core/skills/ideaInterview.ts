import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMetadata } from "../artifacts/types.js";
import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata
} from "../artifacts/versioning.js";
import type { ProjectMode } from "../contracts/domain.js";
import type { SkillContract } from "../contracts/skill.js";

export const IDEA_BUCKET_IDS = [
  "outcome",
  "users_roles",
  "non_goals",
  "inputs",
  "outputs",
  "workflow",
  "interfaces",
  "quality_bar",
  "safety_compliance",
  "failure_modes",
  "evaluation",
  "operations"
] as const;

export type IdeaBucketId = (typeof IDEA_BUCKET_IDS)[number];

interface IdeaBucketDefinition {
  id: IdeaBucketId;
  label: string;
  question_prompt: string;
}

export const IDEA_BUCKET_DEFINITIONS: ReadonlyArray<IdeaBucketDefinition> = [
  {
    id: "outcome",
    label: "Outcome",
    question_prompt: "What concrete outcome should this idea produce?"
  },
  {
    id: "users_roles",
    label: "Users / Roles",
    question_prompt: "Which users or roles are affected?"
  },
  {
    id: "non_goals",
    label: "Non-goals",
    question_prompt: "What is explicitly out of scope?"
  },
  {
    id: "inputs",
    label: "Inputs",
    question_prompt: "What inputs are required?"
  },
  {
    id: "outputs",
    label: "Outputs",
    question_prompt: "What outputs should be produced?"
  },
  {
    id: "workflow",
    label: "Workflow",
    question_prompt: "What is the expected workflow end-to-end?"
  },
  {
    id: "interfaces",
    label: "Interfaces",
    question_prompt: "Which interfaces/contracts are involved?"
  },
  {
    id: "quality_bar",
    label: "Quality Bar",
    question_prompt: "What quality bar must be met?"
  },
  {
    id: "safety_compliance",
    label: "Safety / Compliance",
    question_prompt: "What safety or compliance constraints apply?"
  },
  {
    id: "failure_modes",
    label: "Failure Modes",
    question_prompt: "What failure modes must be handled?"
  },
  {
    id: "evaluation",
    label: "Evaluation",
    question_prompt: "How will success be evaluated?"
  },
  {
    id: "operations",
    label: "Operations",
    question_prompt: "What operational requirements are needed?"
  }
] as const;

type BucketIssueReason = "missing" | "ambiguous";

export interface IdeaInterviewInput {
  project_mode: ProjectMode;
  answers: Partial<Record<IdeaBucketId, string>>;
  proceed_with_assumptions?: boolean;
  max_questions_per_round?: number;
  artifact_dir?: string;
  created_timestamp?: Date;
}

export interface IdeaInterviewQuestion {
  bucket_id: IdeaBucketId;
  prompt: string;
  reason: BucketIssueReason;
}

export interface IdeaInterviewUnresolvedAssumption {
  bucket_id: IdeaBucketId;
  reason: BucketIssueReason;
  assumption: string;
}

export interface IdeaInterviewAssessment {
  should_stop: boolean;
  minimum_required_clarity_reached: boolean;
  proceed_with_assumptions: boolean;
  questions: IdeaInterviewQuestion[];
  unresolved_assumptions: IdeaInterviewUnresolvedAssumption[];
}

export interface IdeaBriefArtifact {
  kind: "idea_brief";
  metadata: ArtifactMetadata;
  project_mode: ProjectMode;
  buckets: Partial<Record<IdeaBucketId, string>>;
  unresolved_assumptions: IdeaInterviewUnresolvedAssumption[];
}

export interface IdeaInterviewResult {
  assessment: IdeaInterviewAssessment;
  artifact?: IdeaBriefArtifact;
}

const REQUIRED_BUCKETS_BY_MODE: Record<ProjectMode, readonly IdeaBucketId[]> = {
  greenfield: IDEA_BUCKET_IDS,
  "existing-repo": IDEA_BUCKET_IDS,
  contribution: IDEA_BUCKET_IDS,
  "feature-proposal": IDEA_BUCKET_IDS
};

const AMBIGUOUS_ANSWER_PATTERNS = [
  /^tbd$/i,
  /^todo$/i,
  /^unknown$/i,
  /^n\/a$/i,
  /^na$/i,
  /^maybe$/i,
  /^later$/i,
  /^\?+$/
] as const;

const DEFAULT_MAX_QUESTIONS_PER_ROUND = 10;
const IDEA_BRIEF_FILENAME = "idea_brief.json";

export const IDEA_INTERVIEW_SKILL_CONTRACT: SkillContract<
  IdeaInterviewInput,
  IdeaInterviewResult
> = {
  name: "skill.ideaInterview",
  version: "v1",
  purpose: "Clarify user intent into a structured idea brief artifact.",
  inputs_schema: {} as IdeaInterviewInput,
  outputs_schema: {} as IdeaInterviewResult,
  side_effects: ["writes idea_brief.json when stopping condition is met"],
  invariants: [
    "Only missing or ambiguous buckets produce questions.",
    "Question count is capped at 10 per round.",
    "Unresolved assumptions are preserved when proceeding with assumptions."
  ],
  idempotency_expectations: [
    "Assessment output is deterministic for identical input values."
  ],
  failure_modes: ["artifact_write_failed", "invalid_existing_artifact"],
  observability_fields: [
    "project_mode",
    "question_count",
    "unresolved_assumption_count",
    "should_stop"
  ]
};

export async function runIdeaInterview(input: IdeaInterviewInput): Promise<IdeaInterviewResult> {
  const assessment = assessIdeaInterviewRound(input);

  if (!assessment.should_stop || !input.artifact_dir) {
    return { assessment };
  }

  const artifact = await writeIdeaBriefArtifact({
    artifact_dir: input.artifact_dir,
    project_mode: input.project_mode,
    answers: input.answers,
    unresolved_assumptions: assessment.unresolved_assumptions,
    ...(input.created_timestamp
      ? { created_timestamp: input.created_timestamp }
      : {})
  });

  return { assessment, artifact };
}

export function assessIdeaInterviewRound(input: IdeaInterviewInput): IdeaInterviewAssessment {
  const requiredBuckets = REQUIRED_BUCKETS_BY_MODE[input.project_mode];
  const unresolved_assumptions: IdeaInterviewUnresolvedAssumption[] = [];

  for (const bucketId of requiredBuckets) {
    const answer = input.answers[bucketId];
    const issueReason = detectBucketIssueReason(answer);
    if (!issueReason) {
      continue;
    }

    unresolved_assumptions.push({
      bucket_id: bucketId,
      reason: issueReason,
      assumption:
        issueReason === "missing"
          ? `No answer was provided for ${bucketId}.`
          : `Answer for ${bucketId} is ambiguous: ${normalizeAnswer(answer)}`
    });
  }

  const proceedWithAssumptions = input.proceed_with_assumptions === true;
  const minimumRequiredClarityReached = unresolved_assumptions.length === 0;
  const shouldStop = minimumRequiredClarityReached || proceedWithAssumptions;
  const maxQuestions = Math.min(
    input.max_questions_per_round ?? DEFAULT_MAX_QUESTIONS_PER_ROUND,
    DEFAULT_MAX_QUESTIONS_PER_ROUND
  );

  const questions: IdeaInterviewQuestion[] = shouldStop
    ? []
    : unresolved_assumptions.slice(0, maxQuestions).map((unresolved) => ({
        bucket_id: unresolved.bucket_id,
        reason: unresolved.reason,
        prompt: getBucketQuestionPrompt(unresolved.bucket_id)
      }));

  return {
    should_stop: shouldStop,
    minimum_required_clarity_reached: minimumRequiredClarityReached,
    proceed_with_assumptions: proceedWithAssumptions,
    questions,
    unresolved_assumptions
  };
}

interface WriteIdeaBriefArtifactInput {
  artifact_dir: string;
  project_mode: ProjectMode;
  answers: Partial<Record<IdeaBucketId, string>>;
  unresolved_assumptions: IdeaInterviewUnresolvedAssumption[];
  created_timestamp?: Date;
}

async function writeIdeaBriefArtifact(input: WriteIdeaBriefArtifactInput): Promise<IdeaBriefArtifact> {
  await mkdir(input.artifact_dir, { recursive: true });

  const artifactPath = join(input.artifact_dir, IDEA_BRIEF_FILENAME);
  const existingArtifact = await readExistingIdeaBriefArtifact(artifactPath);
  const serializedContent = JSON.stringify(
    {
      project_mode: input.project_mode,
      buckets: input.answers,
      unresolved_assumptions: input.unresolved_assumptions
    },
    null,
    2
  );

  const metadata = existingArtifact
    ? createNextArtifactMetadata({
        previous: existingArtifact.metadata,
        generator: "skill.ideaInterview",
        sourceRefs: [],
        content: serializedContent,
        ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
      })
    : createInitialArtifactMetadata({
        artifactId: "idea_brief",
        generator: "skill.ideaInterview",
        sourceRefs: [],
        content: serializedContent,
        ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
      });

  const artifact: IdeaBriefArtifact = {
    kind: "idea_brief",
    metadata,
    project_mode: input.project_mode,
    buckets: input.answers,
    unresolved_assumptions: input.unresolved_assumptions
  };

  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

async function readExistingIdeaBriefArtifact(
  artifactPath: string
): Promise<IdeaBriefArtifact | undefined> {
  try {
    const raw = await readFile(artifactPath, { encoding: "utf8" });
    const parsed = JSON.parse(raw) as Partial<IdeaBriefArtifact>;

    if (
      parsed.kind === "idea_brief" &&
      parsed.metadata?.artifact_id === "idea_brief" &&
      typeof parsed.metadata.artifact_version === "string"
    ) {
      return parsed as IdeaBriefArtifact;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
  }

  return undefined;
}

function detectBucketIssueReason(answer?: string): BucketIssueReason | undefined {
  const normalized = normalizeAnswer(answer);
  if (normalized.length === 0) {
    return "missing";
  }

  for (const pattern of AMBIGUOUS_ANSWER_PATTERNS) {
    if (pattern.test(normalized)) {
      return "ambiguous";
    }
  }

  return undefined;
}

function normalizeAnswer(answer?: string): string {
  return (answer ?? "").trim();
}

function getBucketQuestionPrompt(bucketId: IdeaBucketId): string {
  const found = IDEA_BUCKET_DEFINITIONS.find((bucket) => bucket.id === bucketId);
  if (!found) {
    throw new Error(`Unknown idea interview bucket: ${bucketId}`);
  }

  return found.question_prompt;
}
