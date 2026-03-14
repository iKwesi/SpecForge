import { describe, expect, it } from "vitest";

import { createDefaultPolicyConfig } from "../../src/core/contracts/policy.js";
import {
  evaluateBootstrapPolicyChecks,
  evaluatePolicyConfigCheck
} from "../../src/core/policy/enforcement.js";

describe("policy enforcement", () => {
  it("emits a deterministic policy_config failure with aggregated reason codes", () => {
    const result = evaluatePolicyConfigCheck({
      coverage: {
        scope: "full-repo",
        enforcement: "warn-only"
      },
      parallelism: {
        max_concurrent_tasks: 0,
        serialize_on_uncertainty: "yes"
      },
      gates: {
        enabled_by_default: {
          proposal_approval: true,
          spec_approval: "sometimes",
          execution_start: false
        }
      }
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: "policy_config",
        status: "fail",
        reason_codes: expect.arrayContaining([
          "invalid_coverage_scope",
          "invalid_coverage_enforcement",
          "invalid_parallelism_max_concurrent_tasks",
          "invalid_parallelism_serialize_on_uncertainty",
          "invalid_enabled_gate_type",
          "missing_enabled_gate_key",
          "missing_applicable_project_modes"
        ])
      })
    );
  });

  it("evaluates bootstrap coverage, parallelism, and gate checks through one module", () => {
    const invalidPolicy = createDefaultPolicyConfig();
    invalidPolicy.coverage.enforcement = "unexpected" as never;

    const checks = evaluateBootstrapPolicyChecks(invalidPolicy);

    expect(checks).toEqual([
      expect.objectContaining({
        id: "coverage_policy",
        status: "fail",
        reason_codes: ["invalid_coverage_enforcement"]
      }),
      expect.objectContaining({
        id: "parallelism_policy",
        status: "pass",
        reason_codes: ["parallelism_supported"]
      }),
      expect.objectContaining({
        id: "gate_policy",
        status: "pass",
        reason_codes: ["gate_policy_supported"]
      })
    ]);
  });
});
