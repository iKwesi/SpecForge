import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  ValidateSpecPackError,
  runValidateSpecPack
} from "../../src/core/operations/validateSpecPack.js";
import {
  SPEC_REQUIRED_SECTIONS,
  type SpecArtifactContract
} from "../../src/core/spec/contracts.js";

function buildSpecArtifact(
  overrides?: Partial<SpecArtifactContract>
): SpecArtifactContract {
  const sections = {} as SpecArtifactContract["sections"];
  for (const sectionId of SPEC_REQUIRED_SECTIONS) {
    sections[sectionId] = `content for ${sectionId}`;
  }

  return {
    kind: "spec",
    metadata: {
      artifact_id: "spec.main",
      artifact_version: "v1",
      created_timestamp: "2026-03-12T10:00:00.000Z",
      generator: "operation.generateSpecPack",
      source_refs: [{ artifact_id: "prd.main", artifact_version: "v3" }],
      checksum: "c".repeat(64)
    },
    source_refs: [{ artifact_id: "prd.main", artifact_version: "v3" }],
    sections,
    ...overrides
  };
}

describe("validateSpecPack failure paths", () => {
  it("fails with typed error when spec artifact is missing", async () => {
    await expect(
      runValidateSpecPack({
        artifact_version_index: { "prd.main": "v3" }
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ValidateSpecPackError>>({
        code: "insufficient_spec"
      })
    );
  });
});

describe("validateSpecPack report generation", () => {
  it("emits a passing validation_report artifact when required sections and references are valid", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-validate-spec-"));

    const result = await runValidateSpecPack({
      spec_artifact: buildSpecArtifact(),
      artifact_version_index: { "prd.main": "v3" },
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T11:00:00.000Z")
    });

    expect(result.validation_report.kind).toBe("validation_report");
    expect(result.validation_report.target_artifact_id).toBe("spec.main");
    expect(result.validation_report.passed).toBe(true);
    expect(result.validation_issues).toEqual([]);

    expect(result.validation_report.metadata.artifact_id).toBe("validation_report.spec");
    expect(result.validation_report.metadata.artifact_version).toBe("v1");
    expect(result.validation_report.metadata.generator).toBe("operation.validateSpecPack");

    const written = JSON.parse(
      await readFile(join(artifactDir, "spec", "validation_report.json"), "utf8")
    );
    expect(written.metadata.artifact_id).toBe("validation_report.spec");
    expect(written.passed).toBe(true);
  });

  it("emits missing_required_section when a required SPEC section is blank", async () => {
    const spec = buildSpecArtifact({
      sections: {
        ...buildSpecArtifact().sections,
        work_graph: ""
      }
    });

    const result = await runValidateSpecPack({
      spec_artifact: spec,
      artifact_version_index: { "prd.main": "v3" }
    });

    expect(result.validation_report.passed).toBe(false);
    expect(result.validation_issues).toEqual([
      expect.objectContaining({
        code: "missing_required_section",
        section_id: "work_graph",
        artifact_id: "spec.main"
      })
    ]);
  });

  it("emits invalid_reference for unknown referenced artifact kinds", async () => {
    const spec = buildSpecArtifact({
      source_refs: [{ artifact_id: "mystery.main", artifact_version: "v1" }],
      metadata: {
        ...buildSpecArtifact().metadata,
        source_refs: [{ artifact_id: "mystery.main", artifact_version: "v1" }]
      }
    });

    const result = await runValidateSpecPack({
      spec_artifact: spec,
      artifact_version_index: { "mystery.main": "v1" }
    });

    expect(result.validation_report.passed).toBe(false);
    expect(result.validation_issues).toEqual([
      expect.objectContaining({
        code: "invalid_reference",
        referenced_artifact_id: "mystery.main",
        artifact_id: "spec.main"
      })
    ]);
  });

  it("emits version_mismatch when source ref version differs from artifact version index", async () => {
    const result = await runValidateSpecPack({
      spec_artifact: buildSpecArtifact({
        source_refs: [{ artifact_id: "prd.main", artifact_version: "v3" }],
        metadata: {
          ...buildSpecArtifact().metadata,
          source_refs: [{ artifact_id: "prd.main", artifact_version: "v3" }]
        }
      }),
      artifact_version_index: { "prd.main": "v4" }
    });

    expect(result.validation_report.passed).toBe(false);
    expect(result.validation_issues).toEqual([
      expect.objectContaining({
        code: "version_mismatch",
        referenced_artifact_id: "prd.main",
        expected_version: "v4",
        actual_version: "v3"
      })
    ]);
  });

  it("increments validation_report artifact version on subsequent runs", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-validate-spec-"));

    await runValidateSpecPack({
      spec_artifact: buildSpecArtifact(),
      artifact_version_index: { "prd.main": "v3" },
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T11:00:00.000Z")
    });

    const second = await runValidateSpecPack({
      spec_artifact: buildSpecArtifact(),
      artifact_version_index: { "prd.main": "v3" },
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T11:05:00.000Z")
    });

    expect(second.validation_report.metadata.artifact_version).toBe("v2");
    expect(second.validation_report.metadata.parent_version).toBe("v1");
  });
});
