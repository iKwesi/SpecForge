import { describe, expect, it } from "vitest";

import { createDefaultPolicyConfig } from "../../src/core/contracts/policy.js";
import {
  formatCiPolicyReport,
  runCiPolicyCheck
} from "../../src/core/diagnostics/ciPolicy.js";

describe("runCiPolicyCheck failure paths", () => {
  it("fails when the coverage policy deviates from the supported bootstrap modes", () => {
    const invalidPolicy = createDefaultPolicyConfig();
    invalidPolicy.coverage.enforcement = "unexpected" as never;

    const result = runCiPolicyCheck(invalidPolicy);

    expect(result.overall_status).toBe("fail");
    expect(result.checks).toEqual([
      expect.objectContaining({
        id: "coverage_policy",
        status: "fail"
      }),
      expect.objectContaining({
        id: "parallelism_policy",
        status: "pass"
      }),
      expect.objectContaining({
        id: "gate_policy",
        status: "pass"
      })
    ]);
  });
});

describe("runCiPolicyCheck success paths", () => {
  it("passes the current v1 default policy contract with deterministic report formatting", () => {
    const result = runCiPolicyCheck(createDefaultPolicyConfig());

    expect(result.overall_status).toBe("pass");
    expect(result.summary).toEqual({
      passed: 3,
      failed: 0
    });

    const report = formatCiPolicyReport(result);
    expect(report).toContain("SpecForge CI Policy Check");
    expect(report).toContain("PASS coverage_policy");
    expect(report).toContain("PASS parallelism_policy");
    expect(report).toContain("PASS gate_policy");
    expect(report).toContain("Summary: 3 passed, 0 failed");
  });
});
