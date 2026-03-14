import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { validatePolicyConfig } from "../../src/core/contracts/policy.js";

describe("policy config docs", () => {
  it("publishes a canonical example policy file and linked documentation", async () => {
    const docs = await readFile("docs/POLICY_CONFIG.md", "utf8");
    const readme = await readFile("README.md", "utf8");
    const example = JSON.parse(
      await readFile("docs/examples/specforge.policy.example.json", "utf8")
    ) as unknown;

    expect(docs).toContain("Coverage Policy");
    expect(docs).toContain("Parallelism Policy");
    expect(docs).toContain("Gate Policy");
    expect(docs).toContain("docs/examples/specforge.policy.example.json");
    expect(readme).toContain("Policy Configuration");

    const validation = validatePolicyConfig(example);
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
  });
});
