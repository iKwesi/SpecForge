import {
  buildArtifactVersionIndex,
  resolveArtifactVersion,
  type ArtifactIndex
} from "../artifacts/index.js";
import type {
  ArtifactMetadata,
  ArtifactSourceRef,
  ArtifactVersion
} from "../artifacts/types.js";

export type ReplayableRunErrorCode =
  | "invalid_artifact"
  | "duplicate_artifact"
  | "invalid_record"
  | "cyclic_dependencies"
  | "invalid_contract_filter";

export class ReplayableRunError extends Error {
  readonly code: ReplayableRunErrorCode;
  readonly details?: unknown;

  constructor(code: ReplayableRunErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ReplayableRunError";
    this.code = code;
    this.details = details;
  }
}

export interface ReplayableRunArtifactInput {
  path: string;
  value: unknown;
}

export interface ReplayableRunArtifactEvidence {
  path: string;
  kind?: string;
  artifact_id: string;
  artifact_version: ArtifactVersion;
  generator: string;
  created_timestamp: string;
  checksum: string;
  source_refs: ArtifactSourceRef[];
}

export interface ReplayableRunStep {
  artifact_id: string;
  artifact_version: ArtifactVersion;
  generator: string;
  path: string;
  source_refs: ArtifactSourceRef[];
}

export interface ReplayableRunRecord {
  schema_version: "v1";
  run_id: string;
  replayable: boolean;
  missing_source_refs: ArtifactSourceRef[];
  artifacts: ReplayableRunArtifactEvidence[];
  replay_order: ReplayableRunStep[];
}

export interface RecordReplayableRunInput {
  run_id: string;
  artifacts: ReplayableRunArtifactInput[];
}

export type ContractDriftIssueCode =
  | "stale_contract_version"
  | "missing_contract"
  | "missing_referenced_contract_version";

export interface ContractDriftIssue {
  consumer_artifact_id: string;
  consumer_artifact_version: ArtifactVersion;
  contract_artifact_id: string;
  referenced_version: ArtifactVersion;
  latest_version?: ArtifactVersion;
  issue_code: ContractDriftIssueCode;
}

export interface DiagnoseContractDriftInput {
  record: ReplayableRunRecord;
  artifact_index: ArtifactIndex;
  contract_artifact_ids: string[];
}

export interface ContractDriftResult {
  run_id: string;
  status: "current" | "drift_detected";
  issues: ContractDriftIssue[];
  impacted_artifacts: string[];
}

/**
 * Reconstruct a prior run from artifact metadata alone. The resulting record is
 * deterministic, can be serialized, and makes replay feasibility explicit by
 * surfacing missing source references instead of guessing hidden run state.
 */
export function recordReplayableRun(input: RecordReplayableRunInput): ReplayableRunRecord {
  const runId = normalizeNonEmptyString(input.run_id, "run_id", "invalid_record");
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) {
    throw new ReplayableRunError(
      "invalid_record",
      "artifacts must be a non-empty array."
    );
  }

  const artifacts = input.artifacts.map((artifact) => normalizeReplayableArtifact(artifact));
  const artifactMap = new Map<string, ReplayableRunArtifactEvidence>();
  for (const artifact of artifacts) {
    const key = toArtifactKey(artifact.artifact_id, artifact.artifact_version);
    if (artifactMap.has(key)) {
      throw new ReplayableRunError(
        "duplicate_artifact",
        `Duplicate artifact evidence for ${key}.`
      );
    }

    artifactMap.set(key, artifact);
  }

  const missingSourceRefs = collectMissingSourceRefs(artifacts, artifactMap);
  const replayOrder = buildReplayOrder(artifacts, artifactMap);

  return {
    schema_version: "v1",
    run_id: runId,
    replayable: missingSourceRefs.length === 0,
    missing_source_refs: missingSourceRefs,
    artifacts: [...artifacts].sort(compareArtifacts),
    replay_order: replayOrder
  };
}

export function diagnoseContractDrift(input: DiagnoseContractDriftInput): ContractDriftResult {
  const record = normalizeReplayableRunRecord(input.record);
  const contractArtifactIds = normalizeContractArtifactIds(input.contract_artifact_ids);
  const latestVersions = buildArtifactVersionIndex(input.artifact_index);
  const issues: ContractDriftIssue[] = [];

  for (const artifact of record.artifacts) {
    for (const sourceRef of artifact.source_refs) {
      if (!contractArtifactIds.has(sourceRef.artifact_id)) {
        continue;
      }

      const latestVersion = latestVersions[sourceRef.artifact_id];
      if (!latestVersion) {
        issues.push({
          consumer_artifact_id: artifact.artifact_id,
          consumer_artifact_version: artifact.artifact_version,
          contract_artifact_id: sourceRef.artifact_id,
          referenced_version: sourceRef.artifact_version,
          issue_code: "missing_contract"
        });
        continue;
      }

      const referencedVersion = resolveArtifactVersion(input.artifact_index, {
        artifact_id: sourceRef.artifact_id,
        requested_version: sourceRef.artifact_version
      });
      if (!referencedVersion) {
        issues.push({
          consumer_artifact_id: artifact.artifact_id,
          consumer_artifact_version: artifact.artifact_version,
          contract_artifact_id: sourceRef.artifact_id,
          referenced_version: sourceRef.artifact_version,
          issue_code: "missing_referenced_contract_version"
        });
        continue;
      }

      if (latestVersion !== sourceRef.artifact_version) {
        issues.push({
          consumer_artifact_id: artifact.artifact_id,
          consumer_artifact_version: artifact.artifact_version,
          contract_artifact_id: sourceRef.artifact_id,
          referenced_version: sourceRef.artifact_version,
          latest_version: latestVersion,
          issue_code: "stale_contract_version"
        });
      }
    }
  }

  const sortedIssues = [...issues].sort(compareContractDriftIssues);
  const impactedArtifacts = [...new Set(
    sortedIssues.map(
      (issue) => `${issue.consumer_artifact_id}@${issue.consumer_artifact_version}`
    )
  )];

  return {
    run_id: record.run_id,
    status: sortedIssues.length > 0 ? "drift_detected" : "current",
    issues: sortedIssues,
    impacted_artifacts: impactedArtifacts
  };
}

export function formatContractDriftReport(result: ContractDriftResult): string {
  const lines = ["SpecForge Contract Drift", "", `Run: ${result.run_id}`, `Status: ${result.status}`];

  if (result.issues.length === 0) {
    lines.push("Issues: none");
    return `${lines.join("\n")}\n`;
  }

  lines.push("Issues:");
  for (const issue of result.issues) {
    const consumer = `${issue.consumer_artifact_id}@${issue.consumer_artifact_version}`;
    const contract = `${issue.contract_artifact_id}@${issue.referenced_version}`;
    switch (issue.issue_code) {
      case "stale_contract_version":
        lines.push(
          `- ${consumer} depends on stale contract ${contract} (latest ${issue.latest_version}).`
        );
        break;
      case "missing_contract":
        lines.push(`- ${consumer} depends on missing contract ${contract}.`);
        break;
      case "missing_referenced_contract_version":
        lines.push(`- ${consumer} depends on missing contract version ${contract}.`);
        break;
    }
  }

  lines.push(`Impacted Artifacts: ${result.impacted_artifacts.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

function normalizeReplayableArtifact(
  input: { path: unknown; value: unknown },
  code: ReplayableRunErrorCode = "invalid_artifact"
): ReplayableRunArtifactEvidence {
  if (!isPlainRecord(input)) {
    throw new ReplayableRunError(
      code,
      "replayable artifact input must be an object."
    );
  }

  const path = normalizeNonEmptyString(input.path, "path", code);
  if (!isPlainRecord(input.value)) {
    throw new ReplayableRunError(
      code,
      `artifact file must contain an object: ${path}`
    );
  }

  const value = input.value;
  if (!isPlainRecord(value.metadata)) {
    throw new ReplayableRunError(
      code,
      `artifact metadata must be an object: ${path}`
    );
  }

  const metadata = normalizeArtifactMetadata(value.metadata, path, code);

  return {
    path,
    ...(typeof value.kind === "string" && value.kind.trim().length > 0
      ? { kind: value.kind.trim() }
      : {}),
    artifact_id: metadata.artifact_id,
    artifact_version: metadata.artifact_version,
    generator: metadata.generator,
    created_timestamp: metadata.created_timestamp,
    checksum: metadata.checksum,
    source_refs: metadata.source_refs
  };
}

function normalizeArtifactMetadata(
  value: Record<string, unknown>,
  path: string,
  code: ReplayableRunErrorCode
): ArtifactMetadata {
  const sourceRefsRaw = value.source_refs;
  if (!Array.isArray(sourceRefsRaw)) {
    throw new ReplayableRunError(
      code,
      `artifact metadata.source_refs must be an array: ${path}`
    );
  }

  return {
    artifact_id: normalizeNonEmptyString(value.artifact_id, "artifact_id", code),
    artifact_version: normalizeArtifactVersion(value.artifact_version, path, code),
    ...(value.parent_version !== undefined
      ? { parent_version: normalizeArtifactVersion(value.parent_version, path, code) }
      : {}),
    created_timestamp: normalizeNonEmptyString(
      value.created_timestamp,
      "created_timestamp",
      code
    ),
    generator: normalizeNonEmptyString(value.generator, "generator", code),
    source_refs: normalizeSourceRefs(sourceRefsRaw, path, code),
    checksum: normalizeNonEmptyString(value.checksum, "checksum", code)
  };
}

function normalizeSourceRef(
  value: unknown,
  path: string,
  index: number,
  code: ReplayableRunErrorCode
): ArtifactSourceRef {
  if (!isPlainRecord(value)) {
    throw new ReplayableRunError(
      code,
      `artifact metadata.source_refs[${index}] must be an object: ${path}`
    );
  }

  return {
    artifact_id: normalizeNonEmptyString(
      value.artifact_id,
      `source_refs[${index}].artifact_id`,
      code
    ),
    artifact_version: normalizeArtifactVersion(value.artifact_version, path, code)
  };
}

function normalizeSourceRefs(
  value: unknown[],
  path: string,
  code: ReplayableRunErrorCode
): ArtifactSourceRef[] {
  const byKey = new Map<string, ArtifactSourceRef>();

  for (const [index, sourceRef] of value.entries()) {
    const normalized = normalizeSourceRef(sourceRef, path, index, code);
    byKey.set(toArtifactKey(normalized.artifact_id, normalized.artifact_version), normalized);
  }

  return [...byKey.values()].sort(compareSourceRefs);
}

function collectMissingSourceRefs(
  artifacts: ReplayableRunArtifactEvidence[],
  artifactMap: ReadonlyMap<string, ReplayableRunArtifactEvidence>
): ArtifactSourceRef[] {
  const missing = new Map<string, ArtifactSourceRef>();

  for (const artifact of artifacts) {
    for (const sourceRef of artifact.source_refs) {
      const key = toArtifactKey(sourceRef.artifact_id, sourceRef.artifact_version);
      if (!artifactMap.has(key) && !missing.has(key)) {
        missing.set(key, sourceRef);
      }
    }
  }

  return [...missing.values()].sort(compareSourceRefs);
}

function buildReplayOrder(
  artifacts: ReplayableRunArtifactEvidence[],
  artifactMap: ReadonlyMap<string, ReplayableRunArtifactEvidence>
): ReplayableRunStep[] {
  const inboundCount = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const artifact of artifacts) {
    const artifactKey = toArtifactKey(artifact.artifact_id, artifact.artifact_version);
    let internalDependencyCount = 0;

    for (const sourceRef of artifact.source_refs) {
      const sourceKey = toArtifactKey(sourceRef.artifact_id, sourceRef.artifact_version);
      if (!artifactMap.has(sourceKey)) {
        continue;
      }

      internalDependencyCount += 1;
      const currentDependents = dependents.get(sourceKey) ?? [];
      currentDependents.push(artifactKey);
      dependents.set(sourceKey, currentDependents);
    }

    inboundCount.set(artifactKey, internalDependencyCount);
  }

  const queue = createArtifactPriorityQueue(compareArtifacts);
  for (const artifact of artifacts) {
    const artifactKey = toArtifactKey(artifact.artifact_id, artifact.artifact_version);
    if (inboundCount.get(artifactKey) === 0) {
      queue.push(artifact);
    }
  }

  const ordered: ReplayableRunStep[] = [];

  while (queue.size() > 0) {
    const next = queue.pop()!;
    const nextKey = toArtifactKey(next.artifact_id, next.artifact_version);

    ordered.push({
      artifact_id: next.artifact_id,
      artifact_version: next.artifact_version,
      generator: next.generator,
      path: next.path,
      source_refs: next.source_refs.map((sourceRef) => ({ ...sourceRef }))
    });

    for (const dependentKey of dependents.get(nextKey) ?? []) {
      const remaining = (inboundCount.get(dependentKey) ?? 0) - 1;
      inboundCount.set(dependentKey, remaining);
      if (remaining === 0) {
        const dependent = artifactMap.get(dependentKey);
        if (dependent) {
          queue.push(dependent);
        }
      }
    }
  }

  if (ordered.length !== artifacts.length) {
    throw new ReplayableRunError(
      "cyclic_dependencies",
      "artifact source_refs contain a cycle and cannot be replayed deterministically."
    );
  }

  return ordered;
}

function normalizeReplayableRunRecord(value: ReplayableRunRecord): ReplayableRunRecord {
  if (!isPlainRecord(value)) {
    throw new ReplayableRunError("invalid_record", "replayable run record must be an object.");
  }

  if (value.schema_version !== "v1") {
    throw new ReplayableRunError(
      "invalid_record",
      "replayable run record schema_version must be v1."
    );
  }

  return {
    schema_version: "v1",
    run_id: normalizeNonEmptyString(value.run_id, "run_id", "invalid_record"),
    replayable: typeof value.replayable === "boolean" ? value.replayable : false,
    missing_source_refs: Array.isArray(value.missing_source_refs)
      ? value.missing_source_refs.map((sourceRef, index) =>
          normalizeSourceRef(sourceRef, "record.missing_source_refs", index, "invalid_record")
        )
      : [],
    artifacts: Array.isArray(value.artifacts)
      ? value.artifacts.map((artifact, index) =>
          normalizeRecordArtifactEntry(artifact, index)
        )
      : (() => {
          throw new ReplayableRunError(
            "invalid_record",
            "replayable run record artifacts must be an array."
          );
        })(),
    replay_order: Array.isArray(value.replay_order)
      ? value.replay_order.map((step, index) => normalizeReplayStep(step, index))
      : (() => {
          throw new ReplayableRunError(
            "invalid_record",
            "replayable run record replay_order must be an array."
          );
        })()
  };
}

function normalizeRecordArtifactEntry(
  artifact: unknown,
  index: number
): ReplayableRunArtifactEvidence {
  if (!isPlainRecord(artifact)) {
    throw new ReplayableRunError(
      "invalid_record",
      `replayable run record artifacts[${index}] must be an object.`
    );
  }

  return normalizeReplayableArtifact({
    path: artifact.path,
    value: {
      kind: artifact.kind,
      metadata: {
        artifact_id: artifact.artifact_id,
        artifact_version: artifact.artifact_version,
        created_timestamp: artifact.created_timestamp,
        generator: artifact.generator,
        source_refs: artifact.source_refs,
        checksum: artifact.checksum
      }
    }
  }, "invalid_record");
}

function normalizeReplayStep(step: unknown, index: number): ReplayableRunStep {
  if (!isPlainRecord(step)) {
    throw new ReplayableRunError(
      "invalid_record",
      `replayable run record replay_order[${index}] must be an object.`
    );
  }

  return {
    artifact_id: normalizeNonEmptyString(step.artifact_id, "artifact_id", "invalid_record"),
    artifact_version: normalizeArtifactVersion(
      step.artifact_version,
      "record.replay_order",
      "invalid_record"
    ),
    generator: normalizeNonEmptyString(step.generator, "generator", "invalid_record"),
    path: normalizeNonEmptyString(step.path, "path", "invalid_record"),
    source_refs: Array.isArray(step.source_refs)
      ? step.source_refs.map((sourceRef, sourceRefIndex) =>
          normalizeSourceRef(sourceRef, "record.replay_order", sourceRefIndex, "invalid_record")
        )
      : []
  };
}

function normalizeContractArtifactIds(contractArtifactIds: string[]): Set<string> {
  if (!Array.isArray(contractArtifactIds) || contractArtifactIds.length === 0) {
    throw new ReplayableRunError(
      "invalid_contract_filter",
      "contract_artifact_ids must be a non-empty array."
    );
  }

  return new Set(
    contractArtifactIds.map((artifactId) =>
      normalizeNonEmptyString(artifactId, "contract_artifact_ids", "invalid_contract_filter")
    )
  );
}

function normalizeNonEmptyString(
  value: unknown,
  fieldName: string,
  code: ReplayableRunErrorCode
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ReplayableRunError(code, `${fieldName} must be a non-empty string.`);
  }

  return value.trim();
}

function normalizeArtifactVersion(
  value: unknown,
  path: string,
  code: ReplayableRunErrorCode = "invalid_artifact"
): ArtifactVersion {
  if (typeof value !== "string" || !/^v\d+$/.test(value)) {
    throw new ReplayableRunError(
      code,
      `artifact_version must be in v<number> format: ${path}`
    );
  }

  return value as ArtifactVersion;
}

function toArtifactKey(artifactId: string, artifactVersion: ArtifactVersion): string {
  return `${artifactId}@${artifactVersion}`;
}

function compareArtifacts(
  left: ReplayableRunArtifactEvidence,
  right: ReplayableRunArtifactEvidence
): number {
  const byTimestamp = left.created_timestamp.localeCompare(right.created_timestamp);
  if (byTimestamp !== 0) {
    return byTimestamp;
  }

  const byId = left.artifact_id.localeCompare(right.artifact_id);
  if (byId !== 0) {
    return byId;
  }

  return compareArtifactVersions(left.artifact_version, right.artifact_version);
}

function compareSourceRefs(left: ArtifactSourceRef, right: ArtifactSourceRef): number {
  const byId = left.artifact_id.localeCompare(right.artifact_id);
  if (byId !== 0) {
    return byId;
  }

  return compareArtifactVersions(left.artifact_version, right.artifact_version);
}

function compareContractDriftIssues(left: ContractDriftIssue, right: ContractDriftIssue): number {
  const byConsumerId = left.consumer_artifact_id.localeCompare(right.consumer_artifact_id);
  if (byConsumerId !== 0) {
    return byConsumerId;
  }

  const byConsumerVersion = left.consumer_artifact_version.localeCompare(right.consumer_artifact_version);
  if (byConsumerVersion !== 0) {
    return compareArtifactVersions(left.consumer_artifact_version, right.consumer_artifact_version);
  }

  const byContractId = left.contract_artifact_id.localeCompare(right.contract_artifact_id);
  if (byContractId !== 0) {
    return byContractId;
  }

  return compareArtifactVersions(left.referenced_version, right.referenced_version);
}

function compareArtifactVersions(left: ArtifactVersion, right: ArtifactVersion): number {
  return parseArtifactVersion(left) - parseArtifactVersion(right);
}

function parseArtifactVersion(version: ArtifactVersion): number {
  return Number.parseInt(version.slice(1), 10);
}

function createArtifactPriorityQueue<T>(compare: (left: T, right: T) => number): {
  push(item: T): void;
  pop(): T | undefined;
  size(): number;
} {
  const heap: T[] = [];

  return {
    push(item) {
      heap.push(item);
      bubbleUp(heap.length - 1);
    },
    pop() {
      if (heap.length === 0) {
        return undefined;
      }

      const root = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        bubbleDown(0);
      }

      return root;
    },
    size() {
      return heap.length;
    }
  };

  function bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      if (compare(heap[parentIndex]!, heap[index]!) <= 0) {
        return;
      }

      [heap[parentIndex], heap[index]] = [heap[index]!, heap[parentIndex]!];
      index = parentIndex;
    }
  }

  function bubbleDown(index: number): void {
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      let smallestIndex = index;

      if (
        leftIndex < heap.length &&
        compare(heap[leftIndex]!, heap[smallestIndex]!) < 0
      ) {
        smallestIndex = leftIndex;
      }

      if (
        rightIndex < heap.length &&
        compare(heap[rightIndex]!, heap[smallestIndex]!) < 0
      ) {
        smallestIndex = rightIndex;
      }

      if (smallestIndex === index) {
        return;
      }

      [heap[index], heap[smallestIndex]] = [heap[smallestIndex]!, heap[index]!];
      index = smallestIndex;
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
