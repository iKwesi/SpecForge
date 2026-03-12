import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  EnforceAtomicityError,
  runEnforceAtomicity
} from "../../src/core/operations/enforceAtomicity.js";
import type { WorkGraph } from "../../src/core/operations/decomposeToWorkGraph.js";

function buildWorkGraph(overrides?: Partial<WorkGraph>): WorkGraph {
  return {
    epics: [
      {
        id: "EPIC-1",
        title: "Repository decomposition",
        stories: [
          {
            id: "STORY-1",
            title: "Create initial plan",
            tasks: [
              {
                id: "TASK-A",
                title: "Build parser and validator",
                acceptance_refs: ["AC-1"],
                contract_refs: ["schemas/core.schema.json", "spec.contracts"],
                depends_on: []
              },
              {
                id: "TASK-B",
                title: "Finalize integration",
                acceptance_refs: ["AC-2"],
                contract_refs: ["schemas/core.schema.json"],
                depends_on: ["TASK-A"]
              }
            ]
          }
        ]
      }
    ],
    ...overrides
  };
}

describe("enforceAtomicity failure paths", () => {
  it("fails with typed error when mode is invalid", async () => {
    await expect(
      runEnforceAtomicity({
        project_mode: "greenfield",
        work_graph: buildWorkGraph()
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<EnforceAtomicityError>>({
        code: "invalid_mode"
      })
    );
  });

  it("fails with typed error when work graph is missing", async () => {
    await expect(
      runEnforceAtomicity({
        project_mode: "existing-repo"
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<EnforceAtomicityError>>({
        code: "insufficient_work_graph"
      })
    );
  });

  it("fails with unsplittable_task when oversized task cannot be safely split", async () => {
    const workGraph = buildWorkGraph({
      epics: [
        {
          id: "EPIC-1",
          title: "Atomicity",
          stories: [
            {
              id: "STORY-1",
              title: "Unsplittable",
              tasks: [
                {
                  id: "TASK-X",
                  title:
                    "SupercalifragilisticexpialidociousSupercalifragilisticexpialidocious",
                  acceptance_refs: ["AC-1"],
                  contract_refs: ["schemas/core.schema.json"],
                  depends_on: []
                }
              ]
            }
          ]
        }
      ]
    });

    await expect(
      runEnforceAtomicity({
        project_mode: "existing-repo",
        work_graph: workGraph,
        max_title_length: 24
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<EnforceAtomicityError>>({
        code: "unsplittable_task"
      })
    );
  });
});

describe("enforceAtomicity success paths", () => {
  it("splits unsafe tasks and preserves dependency integrity", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-atomicity-"));

    const workGraph = buildWorkGraph({
      epics: [
        {
          id: "EPIC-1",
          title: "Atomicity",
          stories: [
            {
              id: "STORY-1",
              title: "Split tasks",
              tasks: [
                {
                  id: "TASK-A",
                  title: "Build parser and validator",
                  acceptance_refs: ["AC-1", "AC-2"],
                  contract_refs: ["schemas/core.schema.json", "spec.contracts"],
                  depends_on: []
                },
                {
                  id: "TASK-B",
                  title: "Finalize integration",
                  acceptance_refs: ["AC-3"],
                  contract_refs: ["schemas/core.schema.json"],
                  depends_on: ["TASK-A"]
                }
              ]
            }
          ]
        }
      ]
    });

    const result = await runEnforceAtomicity({
      project_mode: "existing-repo",
      work_graph: workGraph,
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T21:00:00.000Z")
    });

    const tasks = result.refined_work_graph.epics[0]?.stories[0]?.tasks;
    expect(tasks?.map((task) => task.id)).toEqual(["TASK-1", "TASK-2", "TASK-3"]);

    expect(tasks?.[0]).toEqual(
      expect.objectContaining({
        acceptance_refs: ["AC-1"],
        depends_on: []
      })
    );
    expect(tasks?.[1]).toEqual(
      expect.objectContaining({
        acceptance_refs: ["AC-2"],
        depends_on: ["TASK-1"]
      })
    );
    expect(tasks?.[2]).toEqual(
      expect.objectContaining({
        acceptance_refs: ["AC-3"],
        depends_on: ["TASK-2"]
      })
    );

    expect(result.dag_artifact.metadata.artifact_id).toBe("dag.yaml");
    expect(result.dag_artifact.metadata.artifact_version).toBe("v1");
    expect(result.dag_artifact.metadata.generator).toBe("operation.enforceAtomicity");

    const dagYaml = await readFile(join(artifactDir, "spec", "dag.yaml"), "utf8");
    expect(dagYaml).toContain("version: v1");
    expect(dagYaml).toContain("- id: TASK-1");
    expect(dagYaml).toContain("depends_on: []");
  });

  it("increments dag version on subsequent runs", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-atomicity-"));

    await runEnforceAtomicity({
      project_mode: "existing-repo",
      work_graph: buildWorkGraph(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T21:10:00.000Z")
    });

    const second = await runEnforceAtomicity({
      project_mode: "existing-repo",
      work_graph: buildWorkGraph(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T21:15:00.000Z")
    });

    expect(second.dag_artifact.metadata.artifact_version).toBe("v2");
    expect(second.dag_artifact.metadata.parent_version).toBe("v1");

    const dagYaml = await readFile(join(artifactDir, "spec", "dag.yaml"), "utf8");
    expect(dagYaml).toContain("version: v2");
  });
});
