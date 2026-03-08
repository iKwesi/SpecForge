import { describe, expect, it } from "vitest";

import { createInitialArtifactMetadata } from "../../src/core/artifacts/versioning.js";
import { ARTIFACT_OWNERSHIP_REGISTRY } from "../../src/core/spec/ownership.js";
import {
  PRD_REQUIRED_SECTIONS,
  SPEC_REQUIRED_SECTIONS,
  type PrdArtifactContract,
  type SpecArtifactContract
} from "../../src/core/spec/contracts.js";
import {
  validateArtifactReferences,
  validateRequiredSections
} from "../../src/core/spec/validation.js";

function makePrdArtifact(
  sections: Partial<Record<(typeof PRD_REQUIRED_SECTIONS)[number], string>>
): PrdArtifactContract {
  return {
    kind: "prd",
    metadata: createInitialArtifactMetadata({
      artifactId: "prd.main",
      generator: "skill.generatePRD",
      sourceRefs: [{ artifact_id: "idea_brief", artifact_version: "v1" }],
      content: JSON.stringify(sections)
    }),
    sections,
    source_refs: [{ artifact_id: "idea_brief", artifact_version: "v1" }]
  };
}

function makeSpecArtifact(
  sections: Partial<Record<(typeof SPEC_REQUIRED_SECTIONS)[number], string>>
): SpecArtifactContract {
  return {
    kind: "spec",
    metadata: createInitialArtifactMetadata({
      artifactId: "spec.main",
      generator: "skill.generateSpecPack",
      sourceRefs: [{ artifact_id: "prd.main", artifact_version: "v1" }],
      content: JSON.stringify(sections)
    }),
    sections,
    source_refs: [{ artifact_id: "prd.main", artifact_version: "v1" }]
  };
}

describe("required section validation", () => {
  it("returns missing_required_section for absent required PRD sections", () => {
    const prd = makePrdArtifact({
      outcome: "Desired result",
      users_roles: "Engineering manager"
    });

    const issues = validateRequiredSections(prd);

    expect(issues.some((issue) => issue.code === "missing_required_section")).toBe(true);
    expect(issues.some((issue) => issue.section_id === "workflow")).toBe(true);
  });

  it("returns no required-section issues when SPEC contains all required sections", () => {
    const sections: Partial<Record<(typeof SPEC_REQUIRED_SECTIONS)[number], string>> = {};
    for (const section of SPEC_REQUIRED_SECTIONS) {
      sections[section] = `${section} content`;
    }

    const spec = makeSpecArtifact(sections);
    const issues = validateRequiredSections(spec);

    expect(issues).toEqual([]);
  });
});

describe("reference and version validation", () => {
  it("returns invalid_reference when a reference artifact is missing from index", () => {
    const issues = validateArtifactReferences({
      artifactId: "spec.main",
      sourceRefs: [{ artifact_id: "prd.main", artifact_version: "v1" }],
      artifactVersionIndex: {}
    });

    expect(issues).toEqual([
      expect.objectContaining({
        code: "invalid_reference",
        referenced_artifact_id: "prd.main"
      })
    ]);
  });

  it("returns version_mismatch when reference version differs from index", () => {
    const issues = validateArtifactReferences({
      artifactId: "spec.main",
      sourceRefs: [{ artifact_id: "prd.main", artifact_version: "v1" }],
      artifactVersionIndex: { "prd.main": "v2" }
    });

    expect(issues).toEqual([
      expect.objectContaining({
        code: "version_mismatch",
        referenced_artifact_id: "prd.main",
        expected_version: "v2",
        actual_version: "v1"
      })
    ]);
  });

  it("uses ownership registry and returns invalid_reference for unknown artifact kinds", () => {
    expect(ARTIFACT_OWNERSHIP_REGISTRY.prd.owner_skill).toBe("skill.generatePRD");

    const issues = validateArtifactReferences({
      artifactId: "spec.main",
      sourceRefs: [{ artifact_id: "mystery.main", artifact_version: "v1" }],
      artifactVersionIndex: { "mystery.main": "v1" }
    });

    expect(issues).toEqual([
      expect.objectContaining({
        code: "invalid_reference",
        referenced_artifact_id: "mystery.main"
      })
    ]);
  });
});

