import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { GoldenDemoError, runGoldenDemo } from "../../src/demo/goldenDemo.js";

describe("golden demo", () => {
  it("rejects unsafe workspace roots before deleting anything", async () => {
    await expect(
      runGoldenDemo({
        workspace_root: process.cwd()
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GoldenDemoError>>({
        code: "unsafe_workspace_root"
      })
    );
  });

  it("executes the canonical workflow and writes a regression manifest", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "specforge-golden-demo-"));

    const result = await runGoldenDemo({
      workspace_root: workspaceRoot
    });

    expect(result.repository_root).toBe(join(result.workspace_root, "repository"));
    expect(result.artifact_root).toBe(join(result.workspace_root, "artifacts"));
    expect(result.manifest_path).toBe(join(result.workspace_root, "golden-demo-manifest.json"));

    expect(result.command_outputs.doctor).toContain("SpecForge Doctor");
    expect(result.command_outputs.inspect).toContain("SpecForge Inspect");
    expect(result.command_outputs.explain).toContain("SpecForge Explain");
    expect(result.command_outputs.status).toContain("SpecForge Status");

    expect(result.artifacts.idea_brief.artifact_id).toBe("idea_brief");
    expect(result.artifacts.idea_brief.version).toBe("v1");
    expect(result.artifacts.prd_json.artifact_id).toBe("prd.json");
    expect(result.artifacts.spec_index.version).toBe("v1");
    expect(result.artifacts.context_pack.artifact_id).toBe("context_pack.task-1");
    expect(result.artifacts.task_execution_result.artifact_id).toBe(
      "task_execution_result.task-1"
    );
    expect(result.artifacts.critic_result.artifact_id).toBe("critic_result.task-1");

    const manifest = JSON.parse(await readFile(result.manifest_path, "utf8"));
    expect(manifest.scenario_id).toBe("golden-demo.existing-repo");
    expect(manifest.artifacts.task_execution_result.path).toBe(
      join(result.workspace_root, "artifacts", ".specforge", "task-results", "TASK-1.json")
    );
    expect(manifest.command_outputs.inspect).toContain("Architecture Summary");
    expect(manifest.command_outputs.status).toContain("Overall Status: success");
  });
});
