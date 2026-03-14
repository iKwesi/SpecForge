import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMetadata, ArtifactSourceRef, ArtifactVersion } from "../artifacts/types.js";
import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata
} from "../artifacts/versioning.js";
import { createDryRunReport, type DryRunReport } from "../contracts/dryRun.js";
import type { ProjectMode } from "../contracts/domain.js";
import type { OperationContract } from "../contracts/operation.js";
import type { ContextPackArtifact } from "./buildContextPack.js";

const TASK_RESULTS_DIR = join(".specforge", "task-results");
const TDD_PHASE_ORDER = ["red", "green", "refactor"] as const;

export type TddPhase = (typeof TDD_PHASE_ORDER)[number];
export type TddPhaseStatus = "failed" | "passed";

export type DevTddTaskErrorCode =
  | "invalid_mode"
  | "insufficient_context_pack"
  | "invalid_tdd_sequence"
  | "phase_contract_violation"
  | "artifact_write_failed";

export class DevTddTaskError extends Error {
  readonly code: DevTddTaskErrorCode;
  readonly details?: unknown;

  constructor(code: DevTddTaskErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DevTddTaskError";
    this.code = code;
    this.details = details;
  }
}

export interface DevTddTaskPhaseInput {
  phase: TddPhase;
  status: TddPhaseStatus;
  summary: string;
  evidence: string[];
  commands: string[];
}

export interface DevTddTaskInput {
  project_mode: ProjectMode;
  context_pack?: ContextPackArtifact;
  phases: DevTddTaskPhaseInput[];
  branch_ref?: string;
  pr_ref?: string;
  artifact_dir?: string;
  dry_run?: boolean;
  created_timestamp?: Date;
}

export interface DevTddTaskPhaseRecord {
  phase: TddPhase;
  status: TddPhaseStatus;
  summary: string;
  evidence: string[];
  commands: string[];
}

export interface TaskExecutionResultArtifact {
  kind: "task_execution_result";
  metadata: ArtifactMetadata;
  project_mode: "existing-repo";
  task_id: string;
  context_pack_ref: ArtifactSourceRef;
  phase_order: TddPhase[];
  phases: DevTddTaskPhaseRecord[];
  status: "completed";
  branch_ref?: string;
  pr_ref?: string;
  summary_markdown: string;
}

export interface DevTddTaskResult {
  task_execution_result: TaskExecutionResultArtifact;
  dry_run?: DryRunReport;
}

export const DEV_TDD_TASK_OPERATION_CONTRACT: OperationContract<
  DevTddTaskInput,
  DevTddTaskResult
> = {
  name: "operation.devTDDTask",
  version: "v1",
  purpose: "Validate and publish a single-task RED/GREEN/REFACTOR execution result.",
  inputs_schema: {} as DevTddTaskInput,
  outputs_schema: {} as DevTddTaskResult,
  side_effects: ["writes .specforge/task-results/<task_id>.json"],
  invariants: [
    "Execution phases always follow strict RED/GREEN/REFACTOR ordering.",
    "Red must fail first, then green and refactor must preserve passing state.",
    "Branch and PR references are recorded only when explicitly provided by upstream execution tooling."
  ],
  idempotency_expectations: [
    "Equivalent context pack and phase transcript inputs produce stable execution-result artifacts."
  ],
  failure_modes: [
    "invalid_mode",
    "insufficient_context_pack",
    "invalid_tdd_sequence",
    "phase_contract_violation",
    "artifact_write_failed"
  ],
  observability_fields: [
    "task_id",
    "context_pack_version",
    "execution_result_version",
    "phase_count",
    "branch_ref"
  ]
};

/**
 * Publishes a bounded execution result for one atomic task.
 *
 * This slice does not run git operations or retry loops. It validates the recorded
 * TDD transcript from upstream execution tooling and turns it into a versioned,
 * provenance-aware artifact that later critic/repair logic can consume.
 */
export async function runDevTddTask(input: DevTddTaskInput): Promise<DevTddTaskResult> {
  if (input.project_mode !== "existing-repo") {
    throw new DevTddTaskError(
      "invalid_mode",
      "devTDDTask currently supports project_mode=existing-repo."
    );
  }

  const contextPack = ensureContextPack(input.context_pack);
  const phases = normalizePhaseInputs(input.phases);
  ensurePhaseSequence(phases);
  ensurePhaseContract(phases);

  const contextPackRef: ArtifactSourceRef = {
    artifact_id: contextPack.metadata.artifact_id,
    artifact_version: contextPack.metadata.artifact_version
  };

  const artifactDir = input.artifact_dir;
  const previousVersion = artifactDir
    ? await readExistingTaskExecutionResultVersion({ artifact_dir: artifactDir, task_id: contextPack.task.id })
    : undefined;
  const summaryMarkdown = renderExecutionSummaryMarkdown({
    task_id: contextPack.task.id,
    task_title: contextPack.task.title,
    phases,
    ...(input.branch_ref ? { branch_ref: input.branch_ref } : {}),
    ...(input.pr_ref ? { pr_ref: input.pr_ref } : {})
  });

  const taskExecutionResult: TaskExecutionResultArtifact = {
    kind: "task_execution_result",
    metadata: createTaskExecutionResultMetadata({
      task_id: contextPack.task.id,
      source_refs: [contextPackRef],
      content: JSON.stringify({
        task_id: contextPack.task.id,
        context_pack_ref: contextPackRef,
        phases,
        branch_ref: input.branch_ref,
        pr_ref: input.pr_ref,
        summary_markdown: summaryMarkdown
      }),
      ...(previousVersion ? { previous_version: previousVersion } : {}),
      ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
    }),
    project_mode: "existing-repo",
    task_id: contextPack.task.id,
    context_pack_ref: contextPackRef,
    phase_order: [...TDD_PHASE_ORDER],
    phases,
    status: "completed",
    ...(input.branch_ref ? { branch_ref: input.branch_ref } : {}),
    ...(input.pr_ref ? { pr_ref: input.pr_ref } : {}),
    summary_markdown: summaryMarkdown
  };

  if (artifactDir && !input.dry_run) {
    await writeTaskExecutionResultArtifact({
      artifact_dir: artifactDir,
      task_id: contextPack.task.id,
      task_execution_result: taskExecutionResult
    });
  }

  return {
    task_execution_result: taskExecutionResult,
    ...(input.dry_run
      ? {
          dry_run: createDryRunReport([
            {
              status: "planned",
              kind: "task_execution",
              target: contextPack.task.id,
              detail: `Would publish ${join(artifactDir ?? ".", TASK_RESULTS_DIR, `${contextPack.task.id}.json`)} after a valid RED/GREEN/REFACTOR transcript.`
            }
          ])
        }
      : {})
  };
}

function ensureContextPack(contextPack?: ContextPackArtifact): ContextPackArtifact {
  if (!contextPack || contextPack.kind !== "context_pack") {
    throw new DevTddTaskError(
      "insufficient_context_pack",
      "Missing or invalid context_pack artifact."
    );
  }

  if (contextPack.task.id.trim().length === 0) {
    throw new DevTddTaskError(
      "insufficient_context_pack",
      "context_pack task id must be non-empty."
    );
  }

  return contextPack;
}

function normalizePhaseInputs(phases: DevTddTaskPhaseInput[]): DevTddTaskPhaseRecord[] {
  return phases.map((phase) => {
    const summary = phase.summary.trim();
    const evidence = normalizeStringArray(phase.evidence);
    const commands = normalizeStringArray(phase.commands);

    if (summary.length === 0 || evidence.length === 0 || commands.length === 0) {
      throw new DevTddTaskError(
        "phase_contract_violation",
        `Phase ${phase.phase} must include non-empty summary, evidence, and commands.`
      );
    }

    return {
      phase: phase.phase,
      status: phase.status,
      summary,
      evidence,
      commands
    };
  });
}

function ensurePhaseSequence(phases: DevTddTaskPhaseRecord[]): void {
  if (phases.length !== TDD_PHASE_ORDER.length) {
    throw new DevTddTaskError(
      "invalid_tdd_sequence",
      "devTDDTask requires exactly red, green, and refactor phases."
    );
  }

  for (const [index, expectedPhase] of TDD_PHASE_ORDER.entries()) {
    if (phases[index]?.phase !== expectedPhase) {
      throw new DevTddTaskError(
        "invalid_tdd_sequence",
        `Expected phase order ${TDD_PHASE_ORDER.join(" -> ")}.`
      );
    }
  }
}

function ensurePhaseContract(phases: DevTddTaskPhaseRecord[]): void {
  const [redPhase, greenPhase, refactorPhase] = phases;

  // The contract is intentionally strict so later retry logic can reason about
  // exactly which phase failed without inferring intent from free-form logs.
  if (redPhase?.status !== "failed") {
    throw new DevTddTaskError(
      "phase_contract_violation",
      "Red phase must fail first to prove the test drove the change."
    );
  }

  if (greenPhase?.status !== "passed") {
    throw new DevTddTaskError(
      "phase_contract_violation",
      "Green phase must pass after the minimal implementation change."
    );
  }

  if (refactorPhase?.status !== "passed") {
    throw new DevTddTaskError(
      "phase_contract_violation",
      "Refactor phase must preserve a passing state."
    );
  }
}

function normalizeStringArray(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

interface RenderExecutionSummaryMarkdownInput {
  task_id: string;
  task_title: string;
  phases: DevTddTaskPhaseRecord[];
  branch_ref?: string;
  pr_ref?: string;
}

function renderExecutionSummaryMarkdown(input: RenderExecutionSummaryMarkdownInput): string {
  const lines: string[] = [
    "# Task Execution Result",
    "",
    `Task ID: ${input.task_id}`,
    `Task Title: ${input.task_title}`,
    "",
    "Status: completed"
  ];

  if (input.branch_ref) {
    lines.push(`Branch Ref: ${input.branch_ref}`);
  }

  if (input.pr_ref) {
    lines.push(`PR Ref: ${input.pr_ref}`);
  }

  lines.push("");

  for (const phase of input.phases) {
    lines.push(`## ${capitalizePhase(phase.phase)}`);
    lines.push(`Status: ${phase.status}`);
    lines.push(`Summary: ${phase.summary}`);
    lines.push(`Evidence: ${phase.evidence.join(", ")}`);
    lines.push(`Commands: ${phase.commands.join(" | ")}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function capitalizePhase(phase: TddPhase): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

interface CreateTaskExecutionResultMetadataInput {
  task_id: string;
  source_refs: ArtifactSourceRef[];
  content: string;
  previous_version?: ArtifactVersion;
  created_timestamp?: Date;
}

function createTaskExecutionResultMetadata(
  input: CreateTaskExecutionResultMetadataInput
): ArtifactMetadata {
  const artifactId = buildTaskExecutionArtifactId(input.task_id);

  if (!input.previous_version) {
    return createInitialArtifactMetadata({
      artifactId,
      generator: "operation.devTDDTask",
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
      generator: "operation.devTDDTask",
      source_refs: input.source_refs,
      checksum: "0".repeat(64)
    },
    generator: "operation.devTDDTask",
    sourceRefs: input.source_refs,
    content: input.content,
    ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
  });
}

async function readExistingTaskExecutionResultVersion(input: {
  artifact_dir: string;
  task_id: string;
}): Promise<ArtifactVersion | undefined> {
  try {
    const raw = await readFile(
      join(input.artifact_dir, TASK_RESULTS_DIR, `${input.task_id}.json`),
      "utf8"
    );
    const parsed = JSON.parse(raw) as Partial<TaskExecutionResultArtifact>;
    const version = parsed.metadata?.artifact_version;

    if (typeof version === "string" && /^v\d+$/.test(version)) {
      return version as ArtifactVersion;
    }

    throw new DevTddTaskError(
      "artifact_write_failed",
      `Existing task execution result for ${input.task_id} has invalid metadata.artifact_version.`
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof DevTddTaskError) {
      throw error;
    }

    throw new DevTddTaskError(
      "artifact_write_failed",
      `Failed to inspect existing task execution result for ${input.task_id}.`,
      error
    );
  }
}

async function writeTaskExecutionResultArtifact(input: {
  artifact_dir: string;
  task_id: string;
  task_execution_result: TaskExecutionResultArtifact;
}): Promise<void> {
  try {
    const outputDir = join(input.artifact_dir, TASK_RESULTS_DIR);
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, `${input.task_id}.json`),
      `${JSON.stringify(input.task_execution_result, null, 2)}\n`,
      "utf8"
    );
  } catch (error) {
    throw new DevTddTaskError(
      "artifact_write_failed",
      `Failed writing task execution result for ${input.task_id}.`,
      error
    );
  }
}

function buildTaskExecutionArtifactId(taskId: string): `task_execution_result.${string}` {
  return `task_execution_result.${taskId.toLowerCase()}`;
}
