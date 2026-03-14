import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { runBuildContextPack } from "../../src/core/operations/buildContextPack.js";
import type {
  AcceptanceArtifactInput,
  SchemaArtifactInput
} from "../../src/core/operations/decomposeToWorkGraph.js";
import { runDecomposeToWorkGraph } from "../../src/core/operations/decomposeToWorkGraph.js";
import { runGeneratePrd } from "../../src/core/operations/generatePRD.js";
import { runGenerateSpecPack } from "../../src/core/operations/generateSpecPack.js";
import { runIdeaInterview, type IdeaBucketId } from "../../src/core/operations/ideaInterview.js";

function buildExistingRepoAnswers(): Partial<Record<IdeaBucketId, string>> {
  return {
    outcome: "Ship a deterministic existing-repo planning workflow for one bounded API task.",
    users_roles: "Maintainers and contributors working in an existing repository.",
    non_goals: "Do not implement parallel execution or GitHub mutations in this slice.",
    inputs: "An approved idea brief plus deterministic repository planning artifacts.",
    outputs: "PRD, spec pack, work graph, and a task-specific context pack.",
    workflow: "Interview the idea, generate a PRD, build a spec pack, decompose the work graph, and prepare one task context pack.",
    interfaces: "CLI diagnostics, PRD artifacts, SPEC artifacts, and task context pack contracts.",
    quality_bar: "Artifacts must be deterministic, versioned, and provenance-aware.",
    safety_compliance: "No hidden retries, bounded context only, and safe repository writes.",
    failure_modes: "Missing artifact lineage, invalid planning contracts, or incomplete acceptance coverage.",
    evaluation: "The planning chain should produce stable artifacts that downstream operations can consume without translation.",
    operations: "Run locally with Node 22 and pnpm against an existing repository mode workflow."
  };
}

describe("idea -> PRD -> plan integration", () => {
  it("keeps artifact contracts compatible from ideaInterview through buildContextPack", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-idea-plan-integration-"));

    const ideaInterview = await runIdeaInterview({
      project_mode: "existing-repo",
      answers: buildExistingRepoAnswers(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-14T12:00:00.000Z")
    });

    expect(ideaInterview.assessment.should_stop).toBe(true);
    expect(ideaInterview.artifact?.metadata.artifact_id).toBe("idea_brief");
    expect(ideaInterview.artifact?.metadata.artifact_version).toBe("v1");
    const ideaBrief = expectArtifact(ideaInterview.artifact, "ideaInterview artifact");

    const prd = await runGeneratePrd({
      project_mode: "existing-repo",
      idea_brief: ideaBrief,
      idea_brief_status: "approved",
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-14T12:05:00.000Z")
    });

    expect(prd.prd_json.metadata.artifact_id).toBe("prd.json");
    expect(prd.prd_json.source_refs).toEqual([
      {
        artifact_id: "idea_brief",
        artifact_version: "v1"
      }
    ]);

    const specPack = await runGenerateSpecPack({
      project_mode: "existing-repo",
      idea_brief: ideaBrief,
      prd_json: prd.prd_json,
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-14T12:10:00.000Z")
    });
    const acceptanceArtifact = expectAcceptanceArtifact(specPack.acceptance_artifact);
    const schemaArtifact = expectSchemaArtifact(specPack.schema_artifact);

    expect(specPack.spec_artifact.metadata.artifact_id).toBe("spec.main");
    expect(specPack.spec_artifact.source_refs).toEqual([
      {
        artifact_id: "idea_brief",
        artifact_version: "v1"
      },
      {
        artifact_id: "prd.json",
        artifact_version: "v1"
      }
    ]);

    const workGraph = await runDecomposeToWorkGraph({
      project_mode: "existing-repo",
      prd_json: prd.prd_json,
      spec_artifact: specPack.spec_artifact,
      acceptance_artifact: acceptanceArtifact,
      schema_artifact: schemaArtifact,
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-14T12:15:00.000Z")
    });

    const tasks = workGraph.work_graph.epics[0]?.stories[0]?.tasks;
    expect(tasks?.map((task) => task.id)).toEqual(["TASK-1", "TASK-2"]);
    expect(tasks?.[0]?.contract_refs).toEqual(["schemas/core.schema.json", "spec.contracts"]);
    expect(tasks?.[1]?.depends_on).toEqual(["TASK-1"]);

    const contextPack = await runBuildContextPack({
      project_mode: "existing-repo",
      task_id: "TASK-1",
      work_graph: workGraph.work_graph,
      prd_json: prd.prd_json,
      spec_artifact: specPack.spec_artifact,
      acceptance_artifact: acceptanceArtifact,
      schema_artifact: schemaArtifact,
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-14T12:20:00.000Z")
    });

    expect(contextPack.context_pack.metadata.artifact_id).toBe("context_pack.task-1");
    expect(contextPack.context_pack.entries.map((entry) => entry.kind)).toEqual([
      "task_definition",
      "acceptance_excerpt",
      "contract_excerpt",
      "contract_excerpt",
      "prd_excerpt"
    ]);
    expect(contextPack.context_pack.entries[2]?.source_ref).toEqual({
      artifact_id: "schema.core",
      artifact_version: "v1"
    });
    expect(contextPack.context_pack.entries[3]?.source_ref).toEqual({
      artifact_id: "spec.main",
      artifact_version: "v1"
    });

    const writtenPrd = JSON.parse(await readFile(join(artifactDir, "PRD.json"), "utf8"));
    const writtenSpecIndex = JSON.parse(await readFile(join(artifactDir, "spec", "index.json"), "utf8"));
    const writtenDag = await readFile(join(artifactDir, "spec", "dag.yaml"), "utf8");
    const writtenContextPack = JSON.parse(
      await readFile(join(artifactDir, ".specforge", "context-packs", "TASK-1.json"), "utf8")
    );

    expect(writtenPrd.metadata.artifact_id).toBe("prd.json");
    expect(writtenSpecIndex.metadata.artifact_id).toBe("spec.index");
    expect(writtenDag).toContain("version: v1");
    expect(writtenContextPack.metadata.artifact_id).toBe("context_pack.task-1");
  });
});

function expectArtifact<T>(value: T | undefined, label: string): T {
  if (!value) {
    throw new Error(`${label} should be defined.`);
  }

  return value;
}

function expectAcceptanceArtifact(value: unknown): AcceptanceArtifactInput {
  if (!value || typeof value !== "object" || (value as { kind?: string }).kind !== "acceptance_markdown") {
    throw new Error("acceptance artifact should be present and typed as acceptance_markdown.");
  }

  return value as AcceptanceArtifactInput;
}

function expectSchemaArtifact(value: unknown): SchemaArtifactInput {
  if (!value || typeof value !== "object" || (value as { kind?: string }).kind !== "schema_json") {
    throw new Error("schema artifact should be present and typed as schema_json.");
  }

  return value as SchemaArtifactInput;
}
