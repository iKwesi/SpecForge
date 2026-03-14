import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("golden demo docs", () => {
  it("documents how to run the golden demo and its baseline outputs", async () => {
    const docs = await readFile("docs/GOLDEN_DEMO.md", "utf8");
    const readme = await readFile("README.md", "utf8");

    expect(docs).toContain("pnpm demo:golden");
    expect(docs).toContain("sf inspect");
    expect(docs).toContain("sf explain");
    expect(docs).toContain("simulated GitHub status output");
    expect(docs).toContain("golden-demo-manifest.json");
    expect(readme).toContain("Golden Demo");
  });

  it("keeps the fixture repository metadata free of unsupported direct TypeScript runtime scripts", async () => {
    const fixturePackage = JSON.parse(
      await readFile("examples/golden-demo/repository-template/package.json", "utf8")
    ) as {
      scripts?: Record<string, string>;
    };

    expect(fixturePackage.scripts?.start).toBeUndefined();
  });
});
