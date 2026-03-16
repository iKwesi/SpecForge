import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("readme docs", () => {
  it("documents the current install path, workflow surface, and supporting docs", async () => {
    const readme = await readFile("README.md", "utf8");

    expect(readme).toContain("## Why SpecForge");
    expect(readme).toContain("## What You Can Do Today");
    expect(readme).toContain("## Install From Source");
    expect(readme).toContain("package is not published to npm yet");
    expect(readme).toContain("node dist/cli.js doctor");
    expect(readme).toContain("node dist/cli.js inspect --repository-root . --artifact-dir .");
    expect(readme).toContain("node dist/cli.js status --provider gitlab --repo gitlab-org/cli --pr 42");
    expect(readme).toContain("`specforge ...` refers to the built CLI command");
    expect(readme).toContain("node dist/cli.js ...");
    expect(readme).toContain("pnpm exec tsx src/cli.ts ...");
    expect(readme).toContain("pnpm demo:golden");
    expect(readme).toContain("docs/GOLDEN_DEMO.md");
    expect(readme).toContain("docs/POLICY_CONFIG.md");
    expect(readme).toContain("docs/ARCHITECTURE.md");
    expect(readme).toContain("ROADMAP.md");
    expect(readme).toContain("CONTRIBUTING.md");
  });
});
