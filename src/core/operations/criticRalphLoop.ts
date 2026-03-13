import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMetadata, ArtifactSourceRef, ArtifactVersion } from "../artifacts/types.js";
import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata
} from "../artifacts/versioning.js";
import type { ProjectMode } from "../contracts/domain.js";
import type { OperationContract } from "../contracts/operation.js";
import type { TaskExecutionResultArtifact } from "./devTDDTask.js";

const CRITIC_RESULTS_DIR = join(".specforge", "critic-results");
const CRITIC_CHECK_IDS = ["tests_passed", "acceptance_covered", "scope_respected"] as const;
const DEFAULT_MAX_ATTEMPTS = 3;

export type CriticCheckId = (typeof CRITIC_CHECK_IDS)[number];
export type CriticDecision = "accept" | "retry" | "halt";

export type CriticRalphLoopErrorCode =
  | "invalid_mode"
  | "insufficient_task_execution_result"
  | "invalid_critic_checks"
  | "invalid_attempt_state"
  | "stale_context"
  | "artifact_write_failed";

export class CriticRalphLoopError extends Error {
  readonly code: CriticRalphLoopErrorCode;
  readonly details?: unknown;

  constructor(code: CriticRalphLoopErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CriticRalphLoopError";
    this.code = code;
    this.details = details;
  }
}

export interface CriticCheckInput {
  check_id: CriticCheckId;
  passed: boolean;
  detail: string;
}

export interface CriticCheckResult {
  check_id: CriticCheckId;
  passed: boolean;
  detail: string;
}

export interface CriticRalphLoopInput {
  project_mode: ProjectMode;
  task_execution_result?: TaskExecutionResultArtifact;
  attempt_number: number;
  max_attempts?: number;
  critic_checks: CriticCheckInput[];
  previous_critic_results?: CriticResultArtifact[];
  artifact_dir?: string;
  created_timestamp?: Date;
}

export interface CriticResultArtifact {
  kind: "critic_result";
  metadata: ArtifactMetadata;
  project_mode: "existing-repo";
  task_id: string;
  attempt_number: number;
  max_attempts: number;
  task_execution_result_ref: ArtifactSourceRef;
  context_pack_ref: ArtifactSourceRef;
  checks: CriticCheckResult[];
  failed_check_ids: CriticCheckId[];
  decision: CriticDecision;
  requires_fresh_context: boolean;
  next_attempt_number?: number;
  summary_markdown: string;
}

export interface CriticRalphLoopResult {
  critic_result: CriticResultArtifact;
}

export const CRITIC_RALPH_LOOP_OPERATION_CONTRACT: OperationContract<
  CriticRalphLoopInput,
  CriticRalphLoopResult
> = {
  name: "operation.criticRalphLoop",
  version: "v1",
  purpose: "Evaluate explicit critic checks and decide whether a task execution attempt should accept, retry, or halt.",
  inputs_schema: {} as CriticRalphLoopInput,
  outputs_schema: {} as CriticRalphLoopResult,
  side_effects: ["writes .specforge/critic-results/<task_id>.json"],
  invariants: [
    "Critic decisions are derived from explicit named checks, not hidden heuristics.",
    "Repair attempts are bounded by max_attempts.",
    "Retry decisions require a fresh context pack relative to prior attempts."
  ],
  idempotency_expectations: [
    "Equivalent task execution artifacts, critic checks, and attempt state produce stable critic decisions."
  ],
  failure_modes: [
    "invalid_mode",
    "insufficient_task_execution_result",
    "invalid_critic_checks",
    "invalid_attempt_state",
    "stale_context",
    "artifact_write_failed"
  ],
  observability_fields: [
    "task_id",
    "attempt_number",
    "max_attempts",
    "failed_check_count",
    "decision"
  ]
};

/**
 * Applies explicit critic checks to one task execution attempt and returns the bounded
 * Ralph-loop decision for what should happen next.
 *
 * The controller is intentionally deterministic: it does not rerun work itself, and it
 * does not infer hidden failures. It only evaluates named checks plus attempt state.
 */
export async function runCriticRalphLoop(
  input: CriticRalphLoopInput
): Promise<CriticRalphLoopResult> {
  if (input.project_mode !== "existing-repo") {
    throw new CriticRalphLoopError(
      "invalid_mode",
      "criticRalphLoop currently supports project_mode=existing-repo."
    );
  }

  const taskExecutionResult = ensureTaskExecutionResult(input.task_execution_result);
  const maxAttempts = normalizePositiveInteger(input.max_attempts, DEFAULT_MAX_ATTEMPTS, "max_attempts");
  const attemptNumber = normalizePositiveInteger(input.attempt_number, undefined, "attempt_number");

  if (attemptNumber > maxAttempts) {
    throw new CriticRalphLoopError(
      "invalid_attempt_state",
      "attempt_number cannot exceed max_attempts."
    );
  }

  const checks = normalizeCriticChecks(input.critic_checks);
  const previousCriticResults = normalizePreviousCriticResults({
    previous_critic_results: input.previous_critic_results ?? [],
    task_id: taskExecutionResult.task_id,
    attempt_number: attemptNumber,
    max_attempts: maxAttempts
  });

  enforceFreshContext(taskExecutionResult, previousCriticResults);

  const failedCheckIds = checks
    .filter((check) => !check.passed)
    .map((check) => check.check_id)
    .sort((left, right) => left.localeCompare(right));

  const decision = resolveDecision({
    failed_check_ids: failedCheckIds,
    attempt_number: attemptNumber,
    max_attempts: maxAttempts
  });

  const taskExecutionResultRef: ArtifactSourceRef = {
    artifact_id: taskExecutionResult.metadata.artifact_id,
    artifact_version: taskExecutionResult.metadata.artifact_version
  };
  const contextPackRef: ArtifactSourceRef = {
    artifact_id: taskExecutionResult.context_pack_ref.artifact_id,
    artifact_version: taskExecutionResult.context_pack_ref.artifact_version
  };
  const summaryMarkdown = renderCriticSummaryMarkdown({
    task_id: taskExecutionResult.task_id,
    attempt_number: attemptNumber,
    max_attempts: maxAttempts,
    checks,
    failed_check_ids: failedCheckIds,
    decision
  });

  const previousVersion = input.artifact_dir
    ? await readExistingCriticResultVersion({
        artifact_dir: input.artifact_dir,
        task_id: taskExecutionResult.task_id
      })
    : undefined;

  const criticResult: CriticResultArtifact = {
    kind: "critic_result",
    metadata: createCriticResultMetadata({
      task_id: taskExecutionResult.task_id,
      source_refs: [taskExecutionResultRef, contextPackRef],
      content: JSON.stringify({
        task_id: taskExecutionResult.task_id,
        attempt_number: attemptNumber,
        max_attempts: maxAttempts,
        task_execution_result_ref: taskExecutionResultRef,
        context_pack_ref: contextPackRef,
        checks,
        failed_check_ids: failedCheckIds,
        decision,
        next_attempt_number: decision === "retry" ? attemptNumber + 1 : undefined,
        summary_markdown: summaryMarkdown
      }),
      ...(previousVersion ? { previous_version: previousVersion } : {}),
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    }),
    project_mode: "existing-repo",
    task_id: taskExecutionResult.task_id,
    attempt_number: attemptNumber,
    max_attempts: maxAttempts,
    task_execution_result_ref: taskExecutionResultRef,
    context_pack_ref: contextPackRef,
    checks,
    failed_check_ids: failedCheckIds,
    decision,
    requires_fresh_context: decision === "retry",
    ...(decision === "retry" ? { next_attempt_number: attemptNumber + 1 } : {}),
    summary_markdown: summaryMarkdown
  };

  if (input.artifact_dir) {
    await writeCriticResultArtifact({
      artifact_dir: input.artifact_dir,
      task_id: taskExecutionResult.task_id,
      critic_result: criticResult
    });
  }

  return {
    critic_result: criticResult
  };
}

function ensureTaskExecutionResult(
  taskExecutionResult?: TaskExecutionResultArtifact
): TaskExecutionResultArtifact {
  if (!taskExecutionResult || taskExecutionResult.kind !== "task_execution_result") {
    throw new CriticRalphLoopError(
      "insufficient_task_execution_result",
      "Missing or invalid task_execution_result artifact."
    );
  }

  if (taskExecutionResult.task_id.trim().length === 0) {
    throw new CriticRalphLoopError(
      "insufficient_task_execution_result",
      "task_execution_result task_id must be non-empty."
    );
  }

  return taskExecutionResult;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number | undefined,
  field_name: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved === undefined || resolved <= 0) {
    throw new CriticRalphLoopError(
      "invalid_attempt_state",
      `${field_name} must be a positive integer.`
    );
  }

  return resolved;
}

function normalizeCriticChecks(criticChecks: CriticCheckInput[]): CriticCheckResult[] {
  if (criticChecks.length !== CRITIC_CHECK_IDS.length) {
    throw new CriticRalphLoopError(
      "invalid_critic_checks",
      `critic_checks must include exactly ${CRITIC_CHECK_IDS.length} explicit checks.`
    );
  }

  const byId = new Map<CriticCheckId, CriticCheckResult>();
  for (const criticCheck of criticChecks) {
    const detail = criticCheck.detail.trim();
    if (detail.length === 0) {
      throw new CriticRalphLoopError(
        "invalid_critic_checks",
        `critic check ${criticCheck.check_id} must include a non-empty detail.`
      );
    }

    if (byId.has(criticCheck.check_id)) {
      throw new CriticRalphLoopError(
        "invalid_critic_checks",
        `critic check ${criticCheck.check_id} was provided more than once.`
      );
    }

    byId.set(criticCheck.check_id, {
      check_id: criticCheck.check_id,
      passed: criticCheck.passed,
      detail
    });
  }

  const checks: CriticCheckResult[] = [];
  for (const requiredCheckId of CRITIC_CHECK_IDS) {
    const check = byId.get(requiredCheckId);
    if (!check) {
      throw new CriticRalphLoopError(
        "invalid_critic_checks",
        `Missing required critic check: ${requiredCheckId}`
      );
    }

    checks.push(check);
  }

  return checks;
}

function normalizePreviousCriticResults(input: {
  previous_critic_results: CriticResultArtifact[];
  task_id: string;
  attempt_number: number;
  max_attempts: number;
}): CriticResultArtifact[] {
  const previousResults = [...input.previous_critic_results].sort(
    (left, right) => left.attempt_number - right.attempt_number
  );

  if (previousResults.length !== input.attempt_number - 1) {
    throw new CriticRalphLoopError(
      "invalid_attempt_state",
      "previous_critic_results must align with attempt_number - 1."
    );
  }

  for (const [index, previousResult] of previousResults.entries()) {
    if (previousResult.kind !== "critic_result") {
      throw new CriticRalphLoopError(
        "invalid_attempt_state",
        "previous_critic_results must contain critic_result artifacts only."
      );
    }

    if (previousResult.task_id !== input.task_id) {
      throw new CriticRalphLoopError(
        "invalid_attempt_state",
        "previous_critic_results must reference the same task_id as the current attempt."
      );
    }

    if (previousResult.max_attempts !== input.max_attempts) {
      throw new CriticRalphLoopError(
        "invalid_attempt_state",
        "previous_critic_results max_attempts must match the current loop configuration."
      );
    }

    if (previousResult.attempt_number !== index + 1) {
      throw new CriticRalphLoopError(
        "invalid_attempt_state",
        "previous_critic_results must have contiguous attempt numbers starting from 1."
      );
    }
  }

  const latestPrevious = previousResults[previousResults.length - 1];
  if (latestPrevious && latestPrevious.decision !== "retry") {
    throw new CriticRalphLoopError(
      "invalid_attempt_state",
      "A new attempt is only valid after a previous retry decision."
    );
  }

  return previousResults;
}

function enforceFreshContext(
  taskExecutionResult: TaskExecutionResultArtifact,
  previousCriticResults: CriticResultArtifact[]
): void {
  // Fresh-context execution means a retry cannot reuse the same pinned context pack
  // version that a previous failed attempt already consumed.
  for (const previousResult of previousCriticResults) {
    if (
      previousResult.context_pack_ref.artifact_id === taskExecutionResult.context_pack_ref.artifact_id &&
      previousResult.context_pack_ref.artifact_version ===
        taskExecutionResult.context_pack_ref.artifact_version
    ) {
      throw new CriticRalphLoopError(
        "stale_context",
        "Retry attempts must use a fresh context pack version."
      );
    }
  }
}

function resolveDecision(input: {
  failed_check_ids: CriticCheckId[];
  attempt_number: number;
  max_attempts: number;
}): CriticDecision {
  if (input.failed_check_ids.length === 0) {
    return "accept";
  }

  if (input.attempt_number < input.max_attempts) {
    return "retry";
  }

  return "halt";
}

function renderCriticSummaryMarkdown(input: {
  task_id: string;
  attempt_number: number;
  max_attempts: number;
  checks: CriticCheckResult[];
  failed_check_ids: CriticCheckId[];
  decision: CriticDecision;
}): string {
  const lines: string[] = [
    "# Critic Result",
    "",
    `Task ID: ${input.task_id}`,
    `Attempt: ${input.attempt_number}/${input.max_attempts}`,
    `Decision: ${input.decision}`,
    "",
    "## Checks"
  ];

  for (const check of input.checks) {
    lines.push(`- ${check.check_id}: ${check.passed ? "passed" : "failed"}`);
    lines.push(`  Detail: ${check.detail}`);
  }

  lines.push("");
  lines.push("## Failed Checks");
  if (input.failed_check_ids.length === 0) {
    lines.push("- None");
  } else {
    for (const checkId of input.failed_check_ids) {
      lines.push(`- ${checkId}`);
    }
  }

  return lines.join("\n").trimEnd();
}

interface CreateCriticResultMetadataInput {
  task_id: string;
  source_refs: ArtifactSourceRef[];
  content: string;
  previous_version?: ArtifactVersion;
  created_timestamp?: Date;
}

function createCriticResultMetadata(input: CreateCriticResultMetadataInput): ArtifactMetadata {
  const artifactId = buildCriticResultArtifactId(input.task_id);

  if (!input.previous_version) {
    return createInitialArtifactMetadata({
      artifactId,
      generator: "operation.criticRalphLoop",
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
      generator: "operation.criticRalphLoop",
      source_refs: input.source_refs,
      checksum: "0".repeat(64)
    },
    generator: "operation.criticRalphLoop",
    sourceRefs: input.source_refs,
    content: input.content,
    ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
  });
}

async function readExistingCriticResultVersion(input: {
  artifact_dir: string;
  task_id: string;
}): Promise<ArtifactVersion | undefined> {
  try {
    const raw = await readFile(join(input.artifact_dir, CRITIC_RESULTS_DIR, `${input.task_id}.json`), "utf8");
    const parsed = JSON.parse(raw) as Partial<CriticResultArtifact>;
    const version = parsed.metadata?.artifact_version;

    if (typeof version === "string" && /^v\d+$/.test(version)) {
      return version as ArtifactVersion;
    }

    throw new CriticRalphLoopError(
      "artifact_write_failed",
      `Existing critic result for ${input.task_id} has invalid metadata.artifact_version.`
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof CriticRalphLoopError) {
      throw error;
    }

    throw new CriticRalphLoopError(
      "artifact_write_failed",
      `Failed to inspect existing critic result for ${input.task_id}.`,
      error
    );
  }
}

async function writeCriticResultArtifact(input: {
  artifact_dir: string;
  task_id: string;
  critic_result: CriticResultArtifact;
}): Promise<void> {
  try {
    const outputDir = join(input.artifact_dir, CRITIC_RESULTS_DIR);
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, `${input.task_id}.json`),
      `${JSON.stringify(input.critic_result, null, 2)}\n`,
      "utf8"
    );
  } catch (error) {
    throw new CriticRalphLoopError(
      "artifact_write_failed",
      `Failed writing critic result for ${input.task_id}.`,
      error
    );
  }
}

function buildCriticResultArtifactId(taskId: string): `critic_result.${string}` {
  return `critic_result.${taskId.toLowerCase()}`;
}
