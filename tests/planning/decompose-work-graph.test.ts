import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  DecomposeToWorkGraphError,
  runDecomposeToWorkGraph
} from "../../src/core/operations/decomposeToWorkGraph.js";
import type { PrdJsonArtifact } from "../../src/core/operations/generatePRD.js";
import { PRD_REQUIRED_SECTIONS, SPEC_REQUIRED_SECTIONS, type SpecArtifactContract } from "../../src/core/spec/contracts.js";

function buildPrdJson(overrides?: Partial<PrdJsonArtifact>): PrdJsonArtifact {
  const sections = {} as Record<(typeof PRD_REQUIRED_SECTIONS)[number], string>;
  for (const sectionId of PRD_REQUIRED_SECTIONS) {
    sections[sectionId] = `PRD section for ${sectionId}`;
  }

  return {
    kind: "prd_json",
    metadata: {
      artifact_id: "prd.json",
      artifact_version: "v3",
      created_timestamp: "2026-03-12T20:00:00.000Z",
      generator: "operation.generatePRD",
      source_refs: [{ artifact_id: "idea_brief", artifact_version: "v2" }],
      checksum: "a".repeat(64)
    },
    source_refs: [{ artifact_id: "idea_brief", artifact_version: "v2" }],
    project_mode: "existing-repo",
    sections,
    unresolved_assumptions: [],
    ...overrides
  };
}

function buildSpecArtifact(overrides?: Partial<SpecArtifactContract>): SpecArtifactContract {
  const sections = {} as Record<(typeof SPEC_REQUIRED_SECTIONS)[number], string>;
  for (const sectionId of SPEC_REQUIRED_SECTIONS) {
    sections[sectionId] = `SPEC section for ${sectionId}`;
  }

  return {
    kind: "spec",
    metadata: {
      artifact_id: "spec.main",
      artifact_version: "v2",
      created_timestamp: "2026-03-12T20:10:00.000Z",
      generator: "operation.generateSpecPack",
      source_refs: [{ artifact_id: "prd.json", artifact_version: "v3" }],
      checksum: "b".repeat(64)
    },
    source_refs: [{ artifact_id: "prd.json", artifact_version: "v3" }],
    sections,
    ...overrides
  };
}

function buildAcceptanceArtifact() {
  return {
    kind: "acceptance_markdown" as const,
    metadata: {
      artifact_id: "acceptance.core",
      artifact_version: "v2" as const,
      created_timestamp: "2026-03-12T20:11:00.000Z",
      generator: "operation.generateSpecPack",
      source_refs: [{ artifact_id: "prd.json", artifact_version: "v3" as const }],
      checksum: "c".repeat(64)
    },
    source_refs: [{ artifact_id: "prd.json", artifact_version: "v3" as const }],
    path: "acceptance/core.md",
    content: [
      "# Acceptance Criteria",
      "",
      "- system emits deterministic dag output",
      "- tasks reference acceptance criteria and contracts"
    ].join("\n")
  };
}

function buildSchemaArtifact() {
  return {
    kind: "schema_json" as const,
    metadata: {
      artifact_id: "schema.core",
      artifact_version: "v2" as const,
      created_timestamp: "2026-03-12T20:11:30.000Z",
      generator: "operation.generateSpecPack",
      source_refs: [{ artifact_id: "prd.json", artifact_version: "v3" as const }],
      checksum: "d".repeat(64)
    },
    source_refs: [{ artifact_id: "prd.json", artifact_version: "v3" as const }],
    path: "schemas/core.schema.json",
    content: JSON.stringify({ type: "object" }, null, 2)
  };
}

describe("decomposeToWorkGraph failure paths", () => {
  it("fails with typed error when spec artifact is missing", async () => {
    await expect(
      runDecomposeToWorkGraph({
        project_mode: "existing-repo",
        prd_json: buildPrdJson(),
        acceptance_artifact: buildAcceptanceArtifact(),
        schema_artifact: buildSchemaArtifact()
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<DecomposeToWorkGraphError>>({
        code: "insufficient_spec"
      })
    );
  });

  it("fails with typed error when mode is invalid", async () => {
    await expect(
      runDecomposeToWorkGraph({
        project_mode: "greenfield",
        prd_json: buildPrdJson(),
        spec_artifact: buildSpecArtifact(),
        acceptance_artifact: buildAcceptanceArtifact(),
        schema_artifact: buildSchemaArtifact()
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<DecomposeToWorkGraphError>>({
        code: "invalid_mode"
      })
    );
  });
});

describe("decomposeToWorkGraph success paths", () => {
  it("emits dag.yaml tasks that reference acceptance criteria and contracts", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-decompose-"));

    const result = await runDecomposeToWorkGraph({
      project_mode: "existing-repo",
      prd_json: buildPrdJson(),
      spec_artifact: buildSpecArtifact({
        sections: {
          ...buildSpecArtifact().sections,
          summary: "Ship deterministic decomposition",
          contracts: "Use stable schema and contract checks"
        }
      }),
      acceptance_artifact: buildAcceptanceArtifact(),
      schema_artifact: buildSchemaArtifact(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T20:30:00.000Z")
    });

    expect(result.dag_artifact.metadata.artifact_id).toBe("dag.yaml");
    expect(result.dag_artifact.metadata.artifact_version).toBe("v1");
    expect(result.dag_artifact.metadata.generator).toBe("operation.decomposeToWorkGraph");

    expect(result.work_graph.epics).toHaveLength(1);
    const tasks = result.work_graph.epics[0]?.stories[0]?.tasks;
    expect(tasks?.map((task) => task.id)).toEqual(["TASK-1", "TASK-2"]);
    expect(tasks?.[0]?.title).toBe("Satisfy AC-1: system emits deterministic dag output");
    expect(tasks?.[1]?.title).toBe("Satisfy AC-2: tasks reference acceptance criteria and contracts");
    expect(tasks?.[0]?.acceptance_refs).toEqual(["AC-1"]);
    expect(tasks?.[0]?.contract_refs).toEqual(["schemas/core.schema.json", "spec.contracts"]);
    expect(tasks?.[1]?.depends_on).toEqual(["TASK-1"]);

    const dagYaml = await readFile(join(artifactDir, "spec", "dag.yaml"), "utf8");
    expect(dagYaml).toContain("version: v1");
    expect(dagYaml).toContain("acceptance_refs:");
    expect(dagYaml).toContain("contract_refs:");
    expect(dagYaml).toContain("- AC-1");
    expect(dagYaml).toContain("- schemas/core.schema.json");
  });

  it("increments dag artifact version on subsequent runs", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-decompose-"));

    await runDecomposeToWorkGraph({
      project_mode: "existing-repo",
      prd_json: buildPrdJson(),
      spec_artifact: buildSpecArtifact(),
      acceptance_artifact: buildAcceptanceArtifact(),
      schema_artifact: buildSchemaArtifact(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T20:40:00.000Z")
    });

    const second = await runDecomposeToWorkGraph({
      project_mode: "existing-repo",
      prd_json: buildPrdJson(),
      spec_artifact: buildSpecArtifact(),
      acceptance_artifact: buildAcceptanceArtifact(),
      schema_artifact: buildSchemaArtifact(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T20:45:00.000Z")
    });

    expect(second.dag_artifact.metadata.artifact_version).toBe("v2");
    expect(second.dag_artifact.metadata.parent_version).toBe("v1");

    const dagYaml = await readFile(join(artifactDir, "spec", "dag.yaml"), "utf8");
    expect(dagYaml).toContain("version: v2");
  });
});
