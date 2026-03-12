import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { IdeaBriefArtifact } from "../../src/core/operations/ideaInterview.js";
import {
  GeneratePrdError,
  runGeneratePrd
} from "../../src/core/operations/generatePRD.js";
import { PRD_REQUIRED_SECTIONS } from "../../src/core/spec/contracts.js";

function buildIdeaBrief(overrides?: Partial<IdeaBriefArtifact>): IdeaBriefArtifact {
  const buckets: IdeaBriefArtifact["buckets"] = {
    outcome: "Ship a deterministic CLI.",
    users_roles: "Developers and maintainers.",
    non_goals: "No hosted service in v1.",
    inputs: "Idea brief artifact.",
    outputs: "PRD.md and PRD.json.",
    workflow: "Interview, approve, generate PRD.",
    interfaces: "CLI command contracts.",
    quality_bar: "Type-safe and tested.",
    safety_compliance: "Fail safe on invalid state.",
    failure_modes: "Missing artifacts and invalid references.",
    evaluation: "All tests passing.",
    operations: "Local CLI execution."
  };

  return {
    kind: "idea_brief",
    metadata: {
      artifact_id: "idea_brief",
      artifact_version: "v1",
      created_timestamp: "2026-03-08T00:00:00.000Z",
      generator: "operation.ideaInterview",
      source_refs: [],
      checksum: "0".repeat(64)
    },
    project_mode: "greenfield",
    buckets,
    unresolved_assumptions: [],
    ...overrides
  };
}

describe("generatePRD failure paths", () => {
  it("fails with explicit typed error for missing idea_brief", async () => {
    await expect(
      runGeneratePrd({
        project_mode: "greenfield",
        idea_brief_status: "approved"
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GeneratePrdError>>({
        code: "insufficient_idea_brief"
      })
    );
  });

  it("fails with explicit typed error when idea_brief status is not approved/accepted", async () => {
    await expect(
      runGeneratePrd({
        project_mode: "greenfield",
        idea_brief: buildIdeaBrief(),
        idea_brief_status: "draft"
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GeneratePrdError>>({
        code: "insufficient_idea_brief"
      })
    );
  });
});

describe("generatePRD success paths", () => {
  it("reflects unresolved assumptions explicitly in PRD output", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-prd-"));

    const result = await runGeneratePrd({
      project_mode: "greenfield",
      idea_brief_status: "approved",
      idea_brief: buildIdeaBrief({
        unresolved_assumptions: [
          {
            bucket_id: "interfaces",
            reason: "ambiguous",
            assumption: "Answer for interfaces is ambiguous: TBD"
          }
        ]
      }),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-08T12:30:00.000Z")
    });

    expect(result.prd_json.unresolved_assumptions).toHaveLength(1);
    expect(result.prd_json.sections.interfaces).toContain(
      "Assumption: Answer for interfaces is ambiguous: TBD"
    );
    expect(result.prd_md.content).toContain("Assumption: Answer for interfaces is ambiguous: TBD");
  });

  it("produces deterministic required PRD structure in PRD.json and PRD.md", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-prd-"));

    const result = await runGeneratePrd({
      project_mode: "greenfield",
      idea_brief_status: "accepted",
      idea_brief: buildIdeaBrief(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-08T12:40:00.000Z")
    });

    expect(Object.keys(result.prd_json.sections)).toEqual([...PRD_REQUIRED_SECTIONS]);
    expect(result.validation_issues).toEqual([]);
    expect(result.prd_json.metadata.artifact_id).toBe("prd.json");
    expect(result.prd_json.metadata.artifact_version).toBe("v1");
    expect(result.prd_md.metadata.artifact_id).toBe("prd.md");
    expect(result.prd_md.metadata.artifact_version).toBe("v1");

    const prdJsonOnDisk = JSON.parse(
      await readFile(join(artifactDir, "PRD.json"), { encoding: "utf8" })
    );
    expect(prdJsonOnDisk.metadata.artifact_id).toBe("prd.json");
    expect(prdJsonOnDisk.sections.outcome).toBe("Ship a deterministic CLI.");

    const prdMdOnDisk = await readFile(join(artifactDir, "PRD.md"), { encoding: "utf8" });
    expect(prdMdOnDisk.startsWith("# Product Requirements Document\n")).toBe(true);
    expect(prdMdOnDisk).toContain("## Outcome");
    expect(prdMdOnDisk).toContain("## Operations");
  });
});

