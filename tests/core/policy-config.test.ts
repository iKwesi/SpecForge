import { describe, expect, it } from "vitest";

import { PROJECT_MODES } from "../../src/core/contracts/domain.js";
import {
  createDefaultPolicyConfig,
  isKnownGate,
  validatePolicyConfig
} from "../../src/core/contracts/policy.js";

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

  it("validates the default policy shape without schema issues", () => {
    const result = validatePolicyConfig(createDefaultPolicyConfig());

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("reports actionable path-specific issues for invalid policy config", () => {
    const result = validatePolicyConfig({
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
          execution_start: false,
          merge_approval: true
        },
        applicable_project_modes: {
          spec_approval: ["greenfield", "legacy-mode"]
        }
      }
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "coverage.scope"
        }),
        expect.objectContaining({
          path: "coverage.enforcement"
        }),
        expect.objectContaining({
          path: "parallelism.max_concurrent_tasks"
        }),
        expect.objectContaining({
          path: "parallelism.serialize_on_uncertainty"
        }),
        expect.objectContaining({
          path: "gates.enabled_by_default.spec_approval"
        }),
        expect.objectContaining({
          path: "gates.applicable_project_modes.spec_approval[1]"
        })
      ])
    );
    expect(
      result.issues.find((issue) => issue.path === "gates.applicable_project_modes.spec_approval[1]")
        ?.message
    ).toBe(`must be one of ${PROJECT_MODES.join(", ")}.`);
  });

  it("rejects missing gates.applicable_project_modes because the contract requires it", () => {
    const result = validatePolicyConfig({
      ...createDefaultPolicyConfig(),
      gates: {
        enabled_by_default: createDefaultPolicyConfig().gates.enabled_by_default
      }
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "gates.applicable_project_modes"
        })
      ])
    );
  });

  it("rejects unknown enabled gate keys instead of silently accepting typos", () => {
    const result = validatePolicyConfig({
      ...createDefaultPolicyConfig(),
      gates: {
        ...createDefaultPolicyConfig().gates,
        enabled_by_default: {
          ...createDefaultPolicyConfig().gates.enabled_by_default,
          merge_aproval: true
        }
      }
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "gates.enabled_by_default.merge_aproval"
        })
      ])
    );
  });

  it("distinguishes missing required enabled gate keys from wrong-type values", () => {
    const config = createDefaultPolicyConfig();
    const { merge_approval, ...enabledByDefault } = config.gates.enabled_by_default;

    expect(merge_approval).toBe(true);

    const result = validatePolicyConfig({
      ...config,
      gates: {
        ...config.gates,
        enabled_by_default: enabledByDefault
      }
    });

    expect(result.valid).toBe(false);
    expect(
      result.issues.find((issue) => issue.path === "gates.enabled_by_default.merge_approval")?.message
    ).toBe("is required and must be a boolean.");
  });
});
