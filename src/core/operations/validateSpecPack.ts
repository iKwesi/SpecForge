import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMetadata, ArtifactSourceRef, ArtifactVersion } from "../artifacts/types.js";
import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata
} from "../artifacts/versioning.js";
import type { OperationContract } from "../contracts/operation.js";
import type {
  SpecArtifactContract,
  ValidationIssue,
  ValidationReportArtifactContract
} from "../spec/contracts.js";
import {
  validateArtifactReferences,
  validateRequiredSections
} from "../spec/validation.js";

const VALIDATION_REPORT_FILENAME = "validation_report.json";

type ArtifactVersionIndex = Record<string, ArtifactVersion>;

export type ValidateSpecPackErrorCode = "insufficient_spec" | "artifact_write_failed";

export class ValidateSpecPackError extends Error {
  readonly code: ValidateSpecPackErrorCode;
  readonly details?: unknown;

  constructor(code: ValidateSpecPackErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ValidateSpecPackError";
    this.code = code;
    this.details = details;
  }
}

export interface ValidateSpecPackInput {
  spec_artifact?: SpecArtifactContract;
  artifact_version_index?: ArtifactVersionIndex;
  artifact_dir?: string;
  created_timestamp?: Date;
}

export interface ValidateSpecPackResult {
  validation_report: ValidationReportArtifactContract;
  validation_issues: ValidationIssue[];
}

export const VALIDATE_SPEC_PACK_OPERATION_CONTRACT: OperationContract<
  ValidateSpecPackInput,
  ValidateSpecPackResult
> = {
  name: "operation.validateSpecPack",
  version: "v1",
  purpose: "Validate SPEC artifacts deterministically and publish a versioned validation report.",
  inputs_schema: {} as ValidateSpecPackInput,
  outputs_schema: {} as ValidateSpecPackResult,
  side_effects: ["writes spec/validation_report.json artifact when artifact_dir is provided"],
  invariants: [
    "Validation is deterministic for equivalent spec input and version index.",
    "Validation report artifacts carry immutable versioned metadata.",
    "Report issues include explicit validation issue codes."
  ],
  idempotency_expectations: [
    "Issue ordering is stable: required-section checks run before reference/version checks."
  ],
  failure_modes: ["insufficient_spec", "artifact_write_failed"],
  observability_fields: [
    "spec_artifact_id",
    "spec_artifact_version",
    "validation_report_version",
    "validation_issue_count",
    "passed"
  ]
};

export async function runValidateSpecPack(
  input: ValidateSpecPackInput
): Promise<ValidateSpecPackResult> {
  const specArtifact = ensureSpecArtifact(input.spec_artifact);

  const requiredSectionIssues = validateRequiredSections(specArtifact);
  const referenceIssues = validateArtifactReferences({
    artifactId: specArtifact.metadata.artifact_id,
    sourceRefs: specArtifact.source_refs,
    artifactVersionIndex: input.artifact_version_index ?? {}
  });

  const validationIssues = [...requiredSectionIssues, ...referenceIssues];

  const sourceRefs = buildValidationSourceRefs(specArtifact);
  const reportContent = JSON.stringify(
    {
      target_artifact_id: specArtifact.metadata.artifact_id,
      passed: validationIssues.length === 0,
      issues: validationIssues
    },
    null,
    2
  );

  const previousVersion = await readExistingValidationReportVersion(input.artifact_dir);

  const metadata = createValidationMetadata({
    source_refs: sourceRefs,
    content: reportContent,
    ...(previousVersion ? { previous_version: previousVersion } : {}),
    ...(input.created_timestamp ? { created_timestamp: input.created_timestamp } : {})
  });

  const validationReport: ValidationReportArtifactContract = {
    kind: "validation_report",
    metadata,
    target_artifact_id: specArtifact.metadata.artifact_id,
    passed: validationIssues.length === 0,
    issues: validationIssues
  };

  if (input.artifact_dir) {
    await writeValidationReportArtifact(input.artifact_dir, validationReport);
  }

  return {
    validation_report: validationReport,
    validation_issues: validationIssues
  };
}

function ensureSpecArtifact(artifact?: SpecArtifactContract): SpecArtifactContract {
  if (!artifact || artifact.kind !== "spec") {
    throw new ValidateSpecPackError("insufficient_spec", "Missing or invalid spec artifact.");
  }

  if (!artifact.metadata.artifact_id.startsWith("spec.")) {
    throw new ValidateSpecPackError(
      "insufficient_spec",
      "spec artifact metadata.artifact_id must start with spec."
    );
  }

  return artifact;
}

function buildValidationSourceRefs(specArtifact: SpecArtifactContract): ArtifactSourceRef[] {
  const refs: ArtifactSourceRef[] = [
    {
      artifact_id: specArtifact.metadata.artifact_id,
      artifact_version: specArtifact.metadata.artifact_version
    },
    ...specArtifact.source_refs
  ];

  const seen = new Set<string>();
  const deduped: ArtifactSourceRef[] = [];

  for (const ref of refs) {
    const key = `${ref.artifact_id}@${ref.artifact_version}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(ref);
  }

  return deduped;
}

interface CreateValidationMetadataInput {
  previous_version?: ArtifactVersion;
  source_refs: ArtifactSourceRef[];
  content: string;
  created_timestamp?: Date;
}

function createValidationMetadata(input: CreateValidationMetadataInput): ArtifactMetadata {
  if (!input.previous_version) {
    return createInitialArtifactMetadata({
      artifactId: "validation_report.spec",
      generator: "operation.validateSpecPack",
      sourceRefs: input.source_refs,
      content: input.content,
      ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
    });
  }

  return createNextArtifactMetadata({
    previous: {
      artifact_id: "validation_report.spec",
      artifact_version: input.previous_version,
      created_timestamp: "1970-01-01T00:00:00.000Z",
      generator: "operation.validateSpecPack",
      source_refs: input.source_refs,
      checksum: "0".repeat(64)
    },
    generator: "operation.validateSpecPack",
    sourceRefs: input.source_refs,
    content: input.content,
    ...(input.created_timestamp ? { createdTimestamp: input.created_timestamp } : {})
  });
}

async function readExistingValidationReportVersion(
  artifactDir?: string
): Promise<ArtifactVersion | undefined> {
  if (!artifactDir) {
    return undefined;
  }

  try {
    const raw = await readFile(join(artifactDir, "spec", VALIDATION_REPORT_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<ValidationReportArtifactContract>;
    const version = parsed.metadata?.artifact_version;

    if (typeof version === "string" && /^v\d+$/.test(version)) {
      return version as ArtifactVersion;
    }

    throw new ValidateSpecPackError(
      "artifact_write_failed",
      "Existing validation_report has invalid metadata.artifact_version."
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof ValidateSpecPackError) {
      throw error;
    }

    throw new ValidateSpecPackError(
      "artifact_write_failed",
      "Failed to read existing validation report metadata.",
      error
    );
  }
}

async function writeValidationReportArtifact(
  artifactDir: string,
  validationReport: ValidationReportArtifactContract
): Promise<void> {
  const specDir = join(artifactDir, "spec");

  try {
    await mkdir(specDir, { recursive: true });
    await writeFile(
      join(specDir, VALIDATION_REPORT_FILENAME),
      JSON.stringify(validationReport, null, 2),
      "utf8"
    );
  } catch (error) {
    throw new ValidateSpecPackError(
      "artifact_write_failed",
      "Failed writing validation report artifact.",
      error
    );
  }
}
