import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { IdeaBriefArtifact } from "../../src/core/operations/ideaInterview.js";
import type { PrdJsonArtifact } from "../../src/core/operations/generatePRD.js";
import {
  GenerateSpecPackError,
  runGenerateSpecPack
} from "../../src/core/operations/generateSpecPack.js";
import { PRD_REQUIRED_SECTIONS, SPEC_REQUIRED_SECTIONS } from "../../src/core/spec/contracts.js";

function buildIdeaBrief(overrides?: Partial<IdeaBriefArtifact>): IdeaBriefArtifact {
  return {
    kind: "idea_brief",
    metadata: {
      artifact_id: "idea_brief",
      artifact_version: "v2",
      created_timestamp: "2026-03-11T00:00:00.000Z",
      generator: "operation.ideaInterview",
      source_refs: [],
      checksum: "a".repeat(64)
    },
    project_mode: "greenfield",
    buckets: {
      outcome: "Deliver contract-first planning artifacts.",
      users_roles: "Maintainers and contributors.",
      non_goals: "No distributed execution in v1.",
      inputs: "Approved idea and PRD artifacts.",
      outputs: "Spec pack and plan artifacts.",
      workflow: "Interview -> PRD -> Spec Pack.",
      interfaces: "CLI + artifact contracts.",
      quality_bar: "Deterministic output with tests.",
      safety_compliance: "Safe defaults and explicit gates.",
      failure_modes: "Missing source artifacts.",
      evaluation: "All tests pass.",
      operations: "Local-first CLI execution."
    },
    unresolved_assumptions: [],
    ...overrides
  };
}

function buildPrdJson(overrides?: Partial<PrdJsonArtifact>): PrdJsonArtifact {
  const sections = {} as Record<(typeof PRD_REQUIRED_SECTIONS)[number], string>;
  for (const sectionId of PRD_REQUIRED_SECTIONS) {
    sections[sectionId] = `Content for ${sectionId}`;
  }

  return {
    kind: "prd_json",
    metadata: {
      artifact_id: "prd.json",
      artifact_version: "v1",
      created_timestamp: "2026-03-11T00:10:00.000Z",
      generator: "operation.generatePRD",
      source_refs: [{ artifact_id: "idea_brief", artifact_version: "v2" }],
      checksum: "b".repeat(64)
    },
    source_refs: [{ artifact_id: "idea_brief", artifact_version: "v2" }],
    project_mode: "greenfield",
    sections,
    unresolved_assumptions: [],
    ...overrides
  };
}

describe("generateSpecPack failure paths", () => {
  it("fails with typed error when idea_brief is missing", async () => {
    await expect(
      runGenerateSpecPack({
        project_mode: "greenfield",
        prd_json: buildPrdJson()
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GenerateSpecPackError>>({
        code: "insufficient_idea_brief"
      })
    );
  });

  it("fails with typed error when prd_json is missing", async () => {
    await expect(
      runGenerateSpecPack({
        project_mode: "greenfield",
        idea_brief: buildIdeaBrief()
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GenerateSpecPackError>>({
        code: "insufficient_prd"
      })
    );
  });
});

describe("generateSpecPack success paths", () => {
  it("produces deterministic required artifact set and required SPEC section structure", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-spec-pack-"));

    const result = await runGenerateSpecPack({
      project_mode: "greenfield",
      idea_brief: buildIdeaBrief(),
      prd_json: buildPrdJson(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-11T12:00:00.000Z")
    });

    expect(Object.keys(result.spec_artifact.sections)).toEqual([...SPEC_REQUIRED_SECTIONS]);
    expect(result.validation_issues).toEqual([]);

    expect(result.spec_artifact.metadata.artifact_id).toBe("spec.main");
    expect(result.spec_artifact.metadata.artifact_version).toBe("v1");
    expect(result.spec_md.metadata.artifact_id).toBe("spec.md");
    expect(result.spec_md.metadata.artifact_version).toBe("v1");
    expect(result.spec_index.metadata.artifact_id).toBe("spec.index");
    expect(result.spec_index.metadata.artifact_version).toBe("v1");

    const indexPaths = result.spec_index.entries.map((entry) => entry.path);
    expect(indexPaths).toEqual([
      "SPEC.md",
      "schemas/core.schema.json",
      "acceptance/core.md",
      "decisions.md",
      "spec/dag.yaml"
    ]);

    const specMd = await readFile(join(artifactDir, "SPEC.md"), "utf8");
    expect(specMd.startsWith("# Specification\n")).toBe(true);
    expect(specMd).toContain("## Summary");
    expect(specMd).toContain("## Work Graph");

    const schemaJson = JSON.parse(
      await readFile(join(artifactDir, "schemas", "core.schema.json"), "utf8")
    );
    expect(schemaJson.title).toBe("SpecForgeCoreContract");

    const acceptanceMd = await readFile(join(artifactDir, "acceptance", "core.md"), "utf8");
    expect(acceptanceMd).toContain("- AC-1:");
    expect(acceptanceMd).toContain("- AC-2:");

    const indexJson = JSON.parse(await readFile(join(artifactDir, "spec", "index.json"), "utf8"));
    expect(indexJson.metadata.artifact_id).toBe("spec.index");

    const dagYaml = await readFile(join(artifactDir, "spec", "dag.yaml"), "utf8");
    expect(dagYaml).toContain("EPIC-1");
  });

  it("increments artifact versions on subsequent runs", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-spec-pack-"));

    await runGenerateSpecPack({
      project_mode: "greenfield",
      idea_brief: buildIdeaBrief(),
      prd_json: buildPrdJson(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-11T12:00:00.000Z")
    });

    const second = await runGenerateSpecPack({
      project_mode: "greenfield",
      idea_brief: buildIdeaBrief(),
      prd_json: buildPrdJson(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-11T12:10:00.000Z")
    });

    expect(second.spec_artifact.metadata.artifact_version).toBe("v2");
    expect(second.spec_artifact.metadata.parent_version).toBe("v1");
    expect(second.spec_md.metadata.artifact_version).toBe("v2");
    expect(second.spec_md.metadata.parent_version).toBe("v1");
    expect(second.spec_index.metadata.artifact_version).toBe("v2");
    expect(second.spec_index.metadata.parent_version).toBe("v1");
  });
});
