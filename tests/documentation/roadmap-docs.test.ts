import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("roadmap docs", () => {
  it("publishes a contributor-facing roadmap and links it from the README", async () => {
    const roadmap = await readFile("ROADMAP.md", "utf8");
    const readme = await readFile("README.md", "utf8");

    expect(roadmap).toContain("# SpecForge Roadmap");
    expect(roadmap).toContain("## Phase Summary");
    expect(roadmap).toContain("### v1 Foundations");
    expect(roadmap).toContain("### v1.1 Near-Term");
    expect(roadmap).toContain("### Future Expansion");
    expect(roadmap).toContain("https://github.com/iKwesi/SpecForge/issues/61");
    expect(roadmap).toContain("https://github.com/iKwesi/SpecForge/issues/54");
    expect(roadmap).toContain("https://github.com/iKwesi/SpecForge/issues/53");
    expect(readme).toContain("[Roadmap](./ROADMAP.md)");
    expect(readme).toContain("## Roadmap");
  });
});
