import { describe, expect, it } from "vitest";

import {
  createInitialArtifactMetadata,
  createNextArtifactMetadata,
  deriveArtifactVersion,
  hashArtifactContent
} from "../../src/core/artifacts/versioning.js";
import { ARTIFACT_GATES, PROJECT_MODES } from "../../src/core/contracts/domain.js";

describe("artifact versioning invariants", () => {
  it("creates initial metadata with required fields and no parent version", () => {
    const content = JSON.stringify({ data: "v1" });
    const created = createInitialArtifactMetadata({
      artifactId: "spec.index",
      generator: "operation.generateSpecPack",
      sourceRefs: [],
      content
    });

    expect(created.artifact_id).toBe("spec.index");
    expect(created.artifact_version).toBe("v1");
    expect(created.parent_version).toBeUndefined();
    expect(created.created_timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    expect(created.generator).toBe("operation.generateSpecPack");
    expect(created.source_refs).toEqual([]);
    expect(created.checksum).toHaveLength(64);
  });

  it("increments versions and records parent version for derived artifacts", () => {
    const v1 = createInitialArtifactMetadata({
      artifactId: "prd.main",
      generator: "operation.generatePRD",
      sourceRefs: [],
      content: "first"
    });

    const v2 = createNextArtifactMetadata({
      previous: v1,
      generator: "operation.generatePRD",
      sourceRefs: [{ artifact_id: "idea_brief", artifact_version: "v1" }],
      content: "second"
    });

    expect(v2.artifact_version).toBe("v2");
    expect(v2.parent_version).toBe("v1");
  });

  it("derives versions deterministically", () => {
    expect(deriveArtifactVersion()).toBe("v1");
    expect(deriveArtifactVersion("v1")).toBe("v2");
    expect(deriveArtifactVersion("v9")).toBe("v10");
  });

  it("hashes content deterministically", () => {
    const first = hashArtifactContent("abc");
    const second = hashArtifactContent("abc");
    const different = hashArtifactContent("abd");

    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
  });
});

describe("glossary-backed constants", () => {
  it("exposes required project modes", () => {
    expect(PROJECT_MODES).toEqual([
      "greenfield",
      "existing-repo",
      "contribution",
      "feature-proposal"
    ]);
  });

  it("exposes required gate names", () => {
    expect(ARTIFACT_GATES).toEqual([
      "proposal_approval",
      "spec_approval",
      "execution_start",
      "merge_approval"
    ]);
  });
});

