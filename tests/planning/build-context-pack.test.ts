import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  BuildContextPackError,
  runBuildContextPack
} from "../../src/core/operations/buildContextPack.js";
import type {
  AcceptanceArtifactInput,
  SchemaArtifactInput,
  WorkGraph
} from "../../src/core/operations/decomposeToWorkGraph.js";
import type { PrdJsonArtifact } from "../../src/core/operations/generatePRD.js";
import { ARTIFACT_OWNERSHIP_REGISTRY } from "../../src/core/spec/ownership.js";
import { PRD_REQUIRED_SECTIONS, SPEC_REQUIRED_SECTIONS, type SpecArtifactContract } from "../../src/core/spec/contracts.js";

function buildWorkGraph(): WorkGraph {
  return {
    epics: [
      {
        id: "EPIC-1",
        title: "Ship minimal execution prep",
        stories: [
          {
            id: "STORY-1",
            title: "Prepare task inputs",
            tasks: [
              {
                id: "TASK-1",
                title: "Validate acceptance coverage",
                acceptance_refs: ["AC-1"],
                contract_refs: ["schemas/core.schema.json", "spec.contracts"],
                depends_on: []
              },
              {
                id: "TASK-2",
                title: "Check downstream path",
                acceptance_refs: ["AC-2"],
                contract_refs: ["spec.contracts"],
                depends_on: ["TASK-1"]
              }
            ]
          }
        ]
      }
    ]
  };
}

function buildPrdJson(): PrdJsonArtifact {
  const sections = {} as Record<(typeof PRD_REQUIRED_SECTIONS)[number], string>;
  for (const sectionId of PRD_REQUIRED_SECTIONS) {
    sections[sectionId] = `PRD content for ${sectionId}`;
  }

  return {
    kind: "prd_json",
    metadata: {
      artifact_id: "prd.json",
      artifact_version: "v2",
      created_timestamp: "2026-03-12T22:00:00.000Z",
      generator: "operation.generatePRD",
      source_refs: [{ artifact_id: "idea_brief", artifact_version: "v1" }],
      checksum: "a".repeat(64)
    },
    source_refs: [{ artifact_id: "idea_brief", artifact_version: "v1" }],
    project_mode: "existing-repo",
    sections,
    unresolved_assumptions: []
  };
}

function buildSpecArtifact(): SpecArtifactContract {
  const sections = {} as Record<(typeof SPEC_REQUIRED_SECTIONS)[number], string>;
  for (const sectionId of SPEC_REQUIRED_SECTIONS) {
    sections[sectionId] = `SPEC content for ${sectionId}`;
  }

  sections.contracts = "Interfaces: CLI\n\nInputs: PRD and SPEC\n\nOutputs: Context pack and execution payload";

  return {
    kind: "spec",
    metadata: {
      artifact_id: "spec.main",
      artifact_version: "v2",
      created_timestamp: "2026-03-12T22:05:00.000Z",
      generator: "operation.generateSpecPack",
      source_refs: [{ artifact_id: "prd.json", artifact_version: "v2" }],
      checksum: "b".repeat(64)
    },
    source_refs: [{ artifact_id: "prd.json", artifact_version: "v2" }],
    sections
  };
}

function buildAcceptanceArtifact(): AcceptanceArtifactInput {
  return {
    kind: "acceptance_markdown",
    metadata: {
      artifact_id: "acceptance.core",
      artifact_version: "v2",
      created_timestamp: "2026-03-12T22:06:00.000Z",
      generator: "operation.generateSpecPack",
      source_refs: [{ artifact_id: "prd.json", artifact_version: "v2" }],
      checksum: "c".repeat(64)
    },
    source_refs: [{ artifact_id: "prd.json", artifact_version: "v2" }],
    path: "acceptance/core.md",
    content: [
      "# Acceptance Criteria",
      "",
      "- AC-1: verify minimal context pack output",
      "- AC-2: preserve provenance on every excerpt"
    ].join("\n")
  };
}

function buildSchemaArtifact(): SchemaArtifactInput {
  return {
    kind: "schema_json",
    metadata: {
      artifact_id: "schema.core",
      artifact_version: "v2",
      created_timestamp: "2026-03-12T22:07:00.000Z",
      generator: "operation.generateSpecPack",
      source_refs: [{ artifact_id: "prd.json", artifact_version: "v2" }],
      checksum: "d".repeat(64)
    },
    source_refs: [{ artifact_id: "prd.json", artifact_version: "v2" }],
    path: "schemas/core.schema.json",
    content: JSON.stringify(
      {
        title: "SpecForgeCoreContract",
        type: "object",
        required: ["inputs", "outputs"]
      },
      null,
      2
    )
  };
}

describe("buildContextPack failure paths", () => {
  it("fails with typed error when task_id is missing from the work graph", async () => {
    await expect(
      runBuildContextPack({
        project_mode: "existing-repo",
        task_id: "TASK-404",
        work_graph: buildWorkGraph(),
        prd_json: buildPrdJson(),
        spec_artifact: buildSpecArtifact(),
        acceptance_artifact: buildAcceptanceArtifact(),
        schema_artifact: buildSchemaArtifact()
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<BuildContextPackError>>({
        code: "task_not_found"
      })
    );
  });

  it("fails with typed error when mode is invalid", async () => {
    await expect(
      runBuildContextPack({
        project_mode: "greenfield",
        task_id: "TASK-1",
        work_graph: buildWorkGraph(),
        prd_json: buildPrdJson(),
        spec_artifact: buildSpecArtifact(),
        acceptance_artifact: buildAcceptanceArtifact(),
        schema_artifact: buildSchemaArtifact()
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<BuildContextPackError>>({
        code: "invalid_mode"
      })
    );
  });
});

describe("buildContextPack success paths", () => {
  it("registers context_pack ownership to operation.buildContextPack", () => {
    expect(ARTIFACT_OWNERSHIP_REGISTRY.context_pack.owner_operation).toBe(
      "operation.buildContextPack"
    );
  });

  it("builds a minimal provenance-aware context pack for one task", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-context-pack-"));

    const result = await runBuildContextPack({
      project_mode: "existing-repo",
      task_id: "TASK-1",
      work_graph: buildWorkGraph(),
      prd_json: buildPrdJson(),
      spec_artifact: buildSpecArtifact(),
      acceptance_artifact: buildAcceptanceArtifact(),
      schema_artifact: buildSchemaArtifact(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T22:15:00.000Z")
    });

    expect(result.context_pack.kind).toBe("context_pack");
    expect(result.context_pack.metadata.artifact_id).toBe("context_pack.task-1");
    expect(result.context_pack.metadata.artifact_version).toBe("v1");
    expect(result.context_pack.metadata.generator).toBe("operation.buildContextPack");
    expect(result.context_pack.task.id).toBe("TASK-1");

    expect(result.context_pack.entries.map((entry) => entry.kind)).toEqual([
      "task_definition",
      "acceptance_excerpt",
      "contract_excerpt",
      "contract_excerpt",
      "prd_excerpt"
    ]);

    expect(result.context_pack.entries[1]).toEqual(
      expect.objectContaining({
        source_ref: {
          artifact_id: "acceptance.core",
          artifact_version: "v2"
        },
        locator: "AC-1"
      })
    );

    expect(result.context_pack.entries.some((entry) => entry.excerpt.includes("AC-2"))).toBe(false);
    expect(result.context_pack.entries.some((entry) => entry.excerpt.includes("# Acceptance Criteria"))).toBe(
      false
    );

    const written = JSON.parse(
      await readFile(join(artifactDir, ".specforge", "context-packs", "TASK-1.json"), "utf8")
    );
    expect(written.metadata.artifact_id).toBe("context_pack.task-1");
    expect(written.task.id).toBe("TASK-1");
  });

  it("increments context pack version on subsequent runs", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-context-pack-"));

    await runBuildContextPack({
      project_mode: "existing-repo",
      task_id: "TASK-1",
      work_graph: buildWorkGraph(),
      prd_json: buildPrdJson(),
      spec_artifact: buildSpecArtifact(),
      acceptance_artifact: buildAcceptanceArtifact(),
      schema_artifact: buildSchemaArtifact(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T22:20:00.000Z")
    });

    const second = await runBuildContextPack({
      project_mode: "existing-repo",
      task_id: "TASK-1",
      work_graph: buildWorkGraph(),
      prd_json: buildPrdJson(),
      spec_artifact: buildSpecArtifact(),
      acceptance_artifact: buildAcceptanceArtifact(),
      schema_artifact: buildSchemaArtifact(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T22:25:00.000Z")
    });

    expect(second.context_pack.metadata.artifact_version).toBe("v2");
    expect(second.context_pack.metadata.parent_version).toBe("v1");
  });
});
