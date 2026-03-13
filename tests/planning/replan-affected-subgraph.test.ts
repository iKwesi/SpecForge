import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { WorkGraph } from "../../src/core/operations/decomposeToWorkGraph.js";
import {
  ReplanAffectedSubgraphError,
  runReplanAffectedSubgraph
} from "../../src/core/operations/replanAffectedSubgraph.js";
import {
  ARTIFACT_OWNERSHIP_REGISTRY,
  inferArtifactKindFromId
} from "../../src/core/spec/ownership.js";

function buildWorkGraph(): WorkGraph {
  return {
    epics: [
      {
        id: "EPIC-1",
        title: "Execution prep",
        stories: [
          {
            id: "STORY-1",
            title: "Core flow",
            tasks: [
              {
                id: "TASK-1",
                title: "Update contract adapter",
                acceptance_refs: ["AC-1"],
                contract_refs: ["schemas/core.schema.json", "spec.contracts"],
                depends_on: []
              },
              {
                id: "TASK-2",
                title: "Refresh context pack builder",
                acceptance_refs: ["AC-2"],
                contract_refs: ["spec.contracts"],
                depends_on: ["TASK-1"]
              }
            ]
          },
          {
            id: "STORY-2",
            title: "Execution loop",
            tasks: [
              {
                id: "TASK-3",
                title: "Update execution critic",
                acceptance_refs: ["AC-3"],
                contract_refs: ["schemas/critic.schema.json"],
                depends_on: ["TASK-2"]
              }
            ]
          }
        ]
      }
    ]
  };
}

describe("replanAffectedSubgraph failure paths", () => {
  it("fails with a typed error when the work graph is missing", async () => {
    await expect(
      runReplanAffectedSubgraph({
        project_mode: "existing-repo",
        changed_task_ids: ["TASK-1"]
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ReplanAffectedSubgraphError>>({
        code: "insufficient_work_graph"
      })
    );
  });

  it("fails with a typed error when no contract or task changes are provided", async () => {
    await expect(
      runReplanAffectedSubgraph({
        project_mode: "existing-repo",
        work_graph: buildWorkGraph(),
        changed_task_ids: [],
        changed_contract_refs: []
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ReplanAffectedSubgraphError>>({
        code: "empty_change_set"
      })
    );
  });
});

describe("replanAffectedSubgraph success paths", () => {
  it("registers replan_subgraph ownership to operation.replanAffectedSubgraph", () => {
    expect(ARTIFACT_OWNERSHIP_REGISTRY.replan_subgraph.owner_operation).toBe(
      "operation.replanAffectedSubgraph"
    );
    expect(inferArtifactKindFromId("replan_subgraph")).toBe("replan_subgraph");
  });

  it("marks changed contract tasks and their downstream dependents as stale", async () => {
    const result = await runReplanAffectedSubgraph({
      project_mode: "existing-repo",
      work_graph: buildWorkGraph(),
      changed_contract_refs: ["spec.contracts"]
    });

    expect(result.stale_task_ids).toEqual(["TASK-1", "TASK-2", "TASK-3"]);
    expect(result.replan_subgraph.stale_tasks).toEqual([
      {
        task_id: "TASK-1",
        reasons: ["contract_changed"]
      },
      {
        task_id: "TASK-2",
        reasons: ["contract_changed", "upstream_impacted"]
      },
      {
        task_id: "TASK-3",
        reasons: ["upstream_impacted"]
      }
    ]);
  });

  it("marks changed tasks and downstream dependents while preserving task order", async () => {
    const result = await runReplanAffectedSubgraph({
      project_mode: "existing-repo",
      work_graph: buildWorkGraph(),
      changed_task_ids: ["TASK-2"]
    });

    expect(result.stale_task_ids).toEqual(["TASK-2", "TASK-3"]);
    expect(result.updated_subgraph).toEqual({
      epics: [
        {
          id: "EPIC-1",
          title: "Execution prep",
          stories: [
            {
              id: "STORY-1",
              title: "Core flow",
              tasks: [
                {
                  id: "TASK-2",
                  title: "Refresh context pack builder",
                  acceptance_refs: ["AC-2"],
                  contract_refs: ["spec.contracts"],
                  depends_on: []
                }
              ]
            },
            {
              id: "STORY-2",
              title: "Execution loop",
              tasks: [
                {
                  id: "TASK-3",
                  title: "Update execution critic",
                  acceptance_refs: ["AC-3"],
                  contract_refs: ["schemas/critic.schema.json"],
                  depends_on: ["TASK-2"]
                }
              ]
            }
          ]
        }
      ]
    });
  });

  it("writes a versioned replan artifact with stale task metadata", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-replan-subgraph-"));

    await runReplanAffectedSubgraph({
      project_mode: "existing-repo",
      work_graph: buildWorkGraph(),
      changed_task_ids: ["TASK-2"],
      changed_contract_refs: ["spec.contracts"],
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T23:10:00.000Z")
    });

    const second = await runReplanAffectedSubgraph({
      project_mode: "existing-repo",
      work_graph: buildWorkGraph(),
      changed_task_ids: ["TASK-2"],
      changed_contract_refs: ["spec.contracts"],
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T23:12:00.000Z")
    });

    expect(second.replan_subgraph.metadata.artifact_id).toBe("replan_subgraph");
    expect(second.replan_subgraph.metadata.artifact_version).toBe("v2");
    expect(second.replan_subgraph.metadata.parent_version).toBe("v1");
    expect(second.replan_subgraph.metadata.generator).toBe("operation.replanAffectedSubgraph");

    const written = JSON.parse(
      await readFile(join(artifactDir, ".specforge", "replans", "replan_subgraph.json"), "utf8")
    );
    expect(written.metadata.artifact_id).toBe("replan_subgraph");
    expect(written.stale_tasks.map((task: { task_id: string }) => task.task_id)).toEqual([
      "TASK-1",
      "TASK-2",
      "TASK-3"
    ]);
  });
});
