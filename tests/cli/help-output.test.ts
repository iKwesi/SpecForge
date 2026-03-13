import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli.js";

describe("specforge help output", () => {
  it("documents the overall workflow and artifact expectations in top-level help", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("Workflow guide:");
    expect(help).toContain("specforge doctor");
    expect(help).toContain("specforge inspect");
    expect(help).toContain("repository profile and architecture summary artifacts");
    expect(help).toContain("artifact lineage");
  });

  it("includes actionable examples in command help", () => {
    const program = createProgram();
    const inspectHelp = program.commands.find((command) => command.name() === "inspect")?.helpInformation();
    const explainHelp = program.commands.find((command) => command.name() === "explain")?.helpInformation();

    expect(inspectHelp).toContain("in a .specforge subdirectory");
    expect(inspectHelp).toContain("--repository-root . --artifact-dir .");
    expect(explainHelp).toContain("artifact lineage");
    expect(explainHelp).toContain("Example: specforge explain --artifact-file .specforge/task-results/TASK-1.json");
  });
});
