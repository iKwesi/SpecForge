import { describe, expect, it } from "vitest";

import { createDefaultPolicyConfig, isKnownGate } from "../../src/core/contracts/policy.js";

describe("policy config defaults", () => {
  it("uses expected bootstrap gate defaults", () => {
    const config = createDefaultPolicyConfig();

    expect(config.gates.enabled_by_default).toEqual({
      proposal_approval: true,
      spec_approval: true,
      execution_start: false,
      merge_approval: true
    });
  });

  it("uses conservative scheduler defaults", () => {
    const config = createDefaultPolicyConfig();

    expect(config.parallelism.max_concurrent_tasks).toBe(2);
    expect(config.parallelism.serialize_on_uncertainty).toBe(true);
  });

  it("starts changed-lines coverage in report-only mode", () => {
    const config = createDefaultPolicyConfig();

    expect(config.coverage.scope).toBe("changed-lines");
    expect(config.coverage.enforcement).toBe("report-only");
  });

  it("recognizes valid gate names", () => {
    expect(isKnownGate("spec_approval")).toBe(true);
    expect(isKnownGate("not_a_gate")).toBe(false);
  });
});

