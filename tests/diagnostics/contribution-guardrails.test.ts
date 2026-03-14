import { describe, expect, it } from "vitest";

import {
  ContributionGuardrailError,
  formatContributionGuardrailReport,
  runContributionGuardrailCheck
} from "../../src/core/diagnostics/contributionGuardrails.js";

describe("runContributionGuardrailCheck", () => {
  it("passes when contribution changes stay within allowed roots and a small diff budget", () => {
    const result = runContributionGuardrailCheck({
      project_mode: "contribution",
      branch_name: "contrib/docs-help-output",
      changed_files: ["src/cli.ts", "tests/cli/help-output.test.ts"],
      allowed_roots: ["src", "tests"],
      max_changed_files: 3
    });

    expect(result.overall_status).toBe("pass");
    expect(result.checks).toEqual([
      expect.objectContaining({ id: "project_mode", status: "pass" }),
      expect.objectContaining({ id: "branch_policy", status: "pass" }),
      expect.objectContaining({ id: "path_boundary", status: "pass" }),
      expect.objectContaining({ id: "minimal_diff", status: "pass" })
    ]);

    const report = formatContributionGuardrailReport(result);
    expect(report).toContain("SpecForge Contribution Guardrails");
    expect(report).toContain("PASS branch_policy");
    expect(report).toContain("PASS minimal_diff");
  });

  it("fails when changed files leave the allowed contribution roots", () => {
    const result = runContributionGuardrailCheck({
      project_mode: "contribution",
      branch_name: "contrib/unsafe-update",
      changed_files: ["src/cli.ts", ".github/workflows/ci.yml"],
      allowed_roots: ["src", "tests"],
      max_changed_files: 3
    });

    expect(result.overall_status).toBe("fail");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: "path_boundary",
        status: "fail"
      })
    );
    expect(result.summary.failed).toBe(1);
  });

  it("fails when contribution changes exceed the minimal-diff budget", () => {
    const result = runContributionGuardrailCheck({
      project_mode: "contribution",
      branch_name: "contrib/too-wide",
      changed_files: ["src/a.ts", "src/b.ts", "tests/a.test.ts", "README.md"],
      allowed_roots: ["src", "tests", "README.md"],
      max_changed_files: 2
    });

    expect(result.overall_status).toBe("fail");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: "minimal_diff",
        status: "fail"
      })
    );
  });

  it("fails when contribution branch naming does not use a safe prefix", () => {
    const result = runContributionGuardrailCheck({
      project_mode: "contribution",
      branch_name: "feat/unsafe-direct-change",
      changed_files: ["src/cli.ts"],
      allowed_roots: ["src"],
      max_changed_files: 3
    });

    expect(result.overall_status).toBe("fail");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: "branch_policy",
        status: "fail"
      })
    );
  });

  it("rejects non-contribution mode inputs explicitly", () => {
    expect(() =>
      runContributionGuardrailCheck({
        project_mode: "existing-repo",
        branch_name: "contrib/wrong-mode",
        changed_files: ["src/cli.ts"],
        allowed_roots: ["src"],
        max_changed_files: 1
      })
    ).toThrowError(
      expect.objectContaining<Partial<ContributionGuardrailError>>({
        code: "invalid_mode"
      })
    );
  });
});
