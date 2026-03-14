import { readFile } from "node:fs/promises";

import { ARTIFACT_GATES } from "../contracts/domain.js";
import { type SpecForgePolicyConfig } from "../contracts/policy.js";
import type { ConservativeSchedule, ConservativeScheduleBatch } from "../execution/scheduler.js";
import { evaluatePolicyConfigCheck } from "../policy/enforcement.js";

export type ExplainErrorCode =
  | "missing_artifact_input"
  | "artifact_read_failed"
  | "invalid_artifact"
  | "policy_read_failed"
  | "invalid_policy"
  | "schedule_read_failed"
  | "invalid_schedule";

export class ExplainError extends Error {
  readonly code: ExplainErrorCode;
  readonly details?: unknown;

  constructor(code: ExplainErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ExplainError";
    this.code = code;
    this.details = details;
  }
}

export interface ExplainArtifactEvidence {
  path: string;
  kind?: string;
  artifact_id: string;
  artifact_version: string;
  generator: string;
  created_timestamp: string;
  source_refs: Array<{
    artifact_id: string;
    artifact_version: string;
  }>;
}

export interface ExplainPolicyEvidence {
  source: string;
  coverage: SpecForgePolicyConfig["coverage"];
  parallelism: SpecForgePolicyConfig["parallelism"];
  enabled_gates: string[];
  disabled_gates: string[];
}

export interface ExplainScheduleEvidence {
  source: string;
  policy: ConservativeSchedule["policy"];
  batches: ConservativeScheduleBatch[];
}

export interface ExplainResult {
  artifacts: ExplainArtifactEvidence[];
  policy?: ExplainPolicyEvidence;
  schedule?: ExplainScheduleEvidence;
}

export interface RunExplainInput {
  artifact_files: string[];
  policy_file?: string;
  schedule_file?: string;
}

/**
 * Build an evidence-backed explanation from explicit artifact and policy inputs.
 *
 * This slice intentionally explains only what can be proven from the supplied files.
 * It does not infer hidden run state or speculate about decisions that are not present
 * in artifact metadata, policy config, or scheduler output.
 */
export async function runExplain(input: RunExplainInput): Promise<ExplainResult> {
  const artifactFiles = normalizeArtifactFiles(input.artifact_files);
  if (artifactFiles.length === 0) {
    throw new ExplainError(
      "missing_artifact_input",
      "At least one --artifact-file input is required for sf explain."
    );
  }

  const artifacts = await Promise.all(artifactFiles.map((path) => readArtifactEvidence(path)));
  const policy = input.policy_file ? await readPolicyEvidence(input.policy_file) : undefined;
  const schedule = input.schedule_file ? await readScheduleEvidence(input.schedule_file) : undefined;

  return {
    artifacts,
    ...(policy ? { policy } : {}),
    ...(schedule ? { schedule } : {})
  };
}

export function formatExplainReport(result: ExplainResult): string {
  const lines = ["SpecForge Explain", ""];

  lines.push("Artifacts");
  for (const artifact of result.artifacts) {
    lines.push(`- ${artifact.artifact_id} (${artifact.artifact_version})`);
    lines.push(`  path: ${artifact.path}`);
    lines.push(`  generator: ${artifact.generator}`);
    lines.push(`  created: ${artifact.created_timestamp}`);
    if (artifact.kind) {
      lines.push(`  kind: ${artifact.kind}`);
    }
    if (artifact.source_refs.length === 0) {
      lines.push("  source_refs: none");
    } else {
      lines.push(
        `  source_refs: ${artifact.source_refs
          .map((sourceRef) => `${sourceRef.artifact_id}@${sourceRef.artifact_version}`)
          .join(", ")}`
      );
    }
  }

  if (result.policy) {
    lines.push("");
    lines.push("Policy");
    lines.push(`- source: ${result.policy.source}`);
    lines.push(`  max_concurrent_tasks: ${result.policy.parallelism.max_concurrent_tasks}`);
    lines.push(
      `  serialize_on_uncertainty: ${result.policy.parallelism.serialize_on_uncertainty}`
    );
    lines.push(`  coverage_scope: ${result.policy.coverage.scope}`);
    lines.push(`  coverage_enforcement: ${result.policy.coverage.enforcement}`);
    lines.push(
      `  enabled_gates: ${
        result.policy.enabled_gates.length > 0 ? result.policy.enabled_gates.join(", ") : "none"
      }`
    );
    lines.push(
      `  disabled_gates: ${
        result.policy.disabled_gates.length > 0 ? result.policy.disabled_gates.join(", ") : "none"
      }`
    );
  }

  if (result.schedule) {
    lines.push("");
    lines.push("Scheduler Evidence");
    lines.push(`- source: ${result.schedule.source}`);
    for (const batch of result.schedule.batches) {
      lines.push(
        `  ${batch.batch_id}: ${batch.execution_mode} -> ${batch.task_ids.join(", ")} (${batch.reasons.join(", ")})`
      );
    }
  }

  lines.push("");
  lines.push("Reasoning");
  for (const artifact of result.artifacts) {
    lines.push(
      `- ${artifact.artifact_id}@${artifact.artifact_version} was produced by ${artifact.generator} from ${artifact.source_refs.length} source reference(s).`
    );
  }

  if (result.policy) {
    lines.push(
      `- Policy evidence shows max_concurrent_tasks=${result.policy.parallelism.max_concurrent_tasks} and serialize_on_uncertainty=${result.policy.parallelism.serialize_on_uncertainty}.`
    );
  }

  if (result.schedule) {
    for (const batch of result.schedule.batches) {
      lines.push(
        `- Scheduler batch ${batch.batch_id} is ${batch.execution_mode} because of ${batch.reasons.join(", ")}.`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function normalizeArtifactFiles(artifactFiles: string[]): string[] {
  return [...new Set(artifactFiles.map((path) => path.trim()).filter((path) => path.length > 0))];
}

async function readArtifactEvidence(path: string): Promise<ExplainArtifactEvidence> {
  const value = await readJsonFile(path, "artifact_read_failed");
  const artifact = asArtifactEvidenceInput(value, path);

  return {
    path,
    ...(typeof artifact.kind === "string" ? { kind: artifact.kind } : {}),
    artifact_id: artifact.metadata.artifact_id,
    artifact_version: artifact.metadata.artifact_version,
    generator: artifact.metadata.generator,
    created_timestamp: artifact.metadata.created_timestamp,
    source_refs: artifact.metadata.source_refs.map((sourceRef) => ({
      artifact_id: sourceRef.artifact_id,
      artifact_version: sourceRef.artifact_version
    }))
  };
}

async function readPolicyEvidence(path: string): Promise<ExplainPolicyEvidence> {
  const value = await readJsonFile(path, "policy_read_failed");
  const policyCheck = evaluatePolicyConfigCheck(value);
  if (policyCheck.status === "fail") {
    throw new ExplainError(
      "invalid_policy",
      `Invalid policy file: ${path}. ${policyCheck.message.replace(/^Policy configuration is invalid: /, "")}`,
      policyCheck.issues
    );
  }
  const policy = value as SpecForgePolicyConfig;

  const enabledGates = ARTIFACT_GATES.filter((gate) => policy.gates.enabled_by_default[gate] === true);
  const disabledGates = ARTIFACT_GATES.filter((gate) => policy.gates.enabled_by_default[gate] === false);

  return {
    source: path,
    coverage: policy.coverage,
    parallelism: policy.parallelism,
    enabled_gates: enabledGates,
    disabled_gates: disabledGates
  };
}

async function readScheduleEvidence(path: string): Promise<ExplainScheduleEvidence> {
  const value = await readJsonFile(path, "schedule_read_failed");
  if (!isConservativeSchedule(value)) {
    throw new ExplainError("invalid_schedule", `Invalid schedule file: ${path}`);
  }

  return {
    source: path,
    policy: value.policy,
    batches: value.batches
  };
}

async function readJsonFile(path: string, errorCode: ExplainErrorCode): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ExplainError(errorCode, `Failed to read JSON file: ${path}`, error);
  }
}

function asArtifactEvidenceInput(
  value: unknown,
  path: string
): {
  kind?: unknown;
  metadata: {
    artifact_id: string;
    artifact_version: string;
    generator: string;
    created_timestamp: string;
    source_refs: Array<{ artifact_id: string; artifact_version: string }>;
  };
} {
  if (!value || typeof value !== "object") {
    throw new ExplainError("invalid_artifact", `Artifact file must contain an object: ${path}`);
  }

  const candidate = value as {
    kind?: unknown;
    metadata?: {
      artifact_id?: unknown;
      artifact_version?: unknown;
      generator?: unknown;
      created_timestamp?: unknown;
      source_refs?: Array<{ artifact_id?: unknown; artifact_version?: unknown }>;
    };
  };

  if (
    !candidate.metadata ||
    typeof candidate.metadata.artifact_id !== "string" ||
    typeof candidate.metadata.artifact_version !== "string" ||
    typeof candidate.metadata.generator !== "string" ||
    typeof candidate.metadata.created_timestamp !== "string" ||
    !Array.isArray(candidate.metadata.source_refs)
  ) {
    throw new ExplainError(
      "invalid_artifact",
      `Artifact file is missing required metadata fields: ${path}`
    );
  }

  for (const sourceRef of candidate.metadata.source_refs) {
    if (
      !sourceRef ||
      typeof sourceRef.artifact_id !== "string" ||
      typeof sourceRef.artifact_version !== "string"
    ) {
      throw new ExplainError(
        "invalid_artifact",
        `Artifact file contains an invalid source_ref entry: ${path}`
      );
    }
  }

  return {
    kind: candidate.kind,
    metadata: {
      artifact_id: candidate.metadata.artifact_id,
      artifact_version: candidate.metadata.artifact_version,
      generator: candidate.metadata.generator,
      created_timestamp: candidate.metadata.created_timestamp,
      source_refs: candidate.metadata.source_refs as Array<{
        artifact_id: string;
        artifact_version: string;
      }>
    }
  };
}

function isConservativeSchedule(value: unknown): value is ConservativeSchedule {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ConservativeSchedule>;
  return (
    !!candidate.policy &&
    typeof candidate.policy.max_concurrent_tasks === "number" &&
    typeof candidate.policy.serialize_on_uncertainty === "boolean" &&
    Array.isArray(candidate.batches) &&
    candidate.batches.every(
      (batch) =>
        batch &&
        typeof batch.batch_id === "string" &&
        (batch.execution_mode === "serial" || batch.execution_mode === "parallel") &&
        Array.isArray(batch.task_ids) &&
        Array.isArray(batch.reasons)
    )
  );
}
