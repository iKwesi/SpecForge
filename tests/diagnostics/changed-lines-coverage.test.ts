import { describe, expect, it } from "vitest";

import { createDefaultPolicyConfig } from "../../src/core/contracts/policy.js";
import {
  formatChangedLinesCoverageReport,
  parseChangedLinesDiff,
  runChangedLinesCoverageCheck
} from "../../src/core/diagnostics/changedLinesCoverage.js";

describe("parseChangedLinesDiff", () => {
  it("captures changed line numbers from zero-context git diff output", () => {
    const diff = [
      "diff --git a/src/core/example.ts b/src/core/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/core/example.ts",
      "+++ b/src/core/example.ts",
      "@@ -10,0 +11,2 @@",
      "+const covered = true;",
      "+const uncovered = false;",
      "@@ -20 +22 @@",
      "-return oldValue;",
      "+return newValue;"
    ].join("\n");

    const changedLines = parseChangedLinesDiff(diff);

    expect(changedLines).toEqual(
      new Map<string, number[]>([["src/core/example.ts", [11, 12, 22]]])
    );
  });
});

describe("runChangedLinesCoverageCheck", () => {
  it("reports uncovered changed lines without failing overall in report-only mode", () => {
    const policy = createDefaultPolicyConfig().coverage;
    const diff = [
      "diff --git a/src/core/example.ts b/src/core/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/core/example.ts",
      "+++ b/src/core/example.ts",
      "@@ -10,0 +11,2 @@",
      "+const covered = true;",
      "+const uncovered = false;"
    ].join("\n");
    const lcov = [
      "TN:",
      "SF:src/core/example.ts",
      "DA:11,1",
      "DA:12,0",
      "end_of_record"
    ].join("\n");

    const result = runChangedLinesCoverageCheck({
      policy,
      diff,
      lcov
    });

    expect(result.evaluation_status).toBe("fail");
    expect(result.overall_status).toBe("pass");
    expect(result.summary).toEqual({
      changed_source_lines: 2,
      executable_changed_lines: 2,
      covered_lines: 1,
      uncovered_lines: 1,
      missing_coverage_lines: 0,
      non_measurable_lines: 0,
      coverage_percent: 50
    });
    expect(result.files).toEqual([
      expect.objectContaining({
        path: "src/core/example.ts",
        covered_lines: [11],
        uncovered_lines: [12],
        missing_coverage_lines: [],
        non_measurable_lines: []
      })
    ]);

    const report = formatChangedLinesCoverageReport(result);
    expect(report).toContain("SpecForge Changed-Lines Coverage");
    expect(report).toContain("Evaluation: FAIL");
    expect(report).toContain("Enforcement: PASS (report-only)");
  });

  it("fails overall in hard-block mode when a changed source file has no coverage record", () => {
    const policy = {
      ...createDefaultPolicyConfig().coverage,
      enforcement: "hard-block" as const
    };
    const diff = [
      "diff --git a/src/core/missing.ts b/src/core/missing.ts",
      "index 1111111..2222222 100644",
      "--- a/src/core/missing.ts",
      "+++ b/src/core/missing.ts",
      "@@ -4,0 +5,2 @@",
      "+export const value = 1;",
      "+export const nextValue = value + 1;"
    ].join("\n");
    const lcov = [
      "TN:",
      "SF:src/core/example.ts",
      "DA:11,1",
      "end_of_record"
    ].join("\n");

    const result = runChangedLinesCoverageCheck({
      policy,
      diff,
      lcov
    });

    expect(result.evaluation_status).toBe("fail");
    expect(result.overall_status).toBe("fail");
    expect(result.summary.missing_coverage_lines).toBe(2);
    expect(result.files).toEqual([
      expect.objectContaining({
        path: "src/core/missing.ts",
        missing_coverage_lines: [5, 6]
      })
    ]);
  });

  it("ignores changed files outside src when evaluating changed-lines coverage", () => {
    const policy = createDefaultPolicyConfig().coverage;
    const diff = [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-Old line",
      "+New line"
    ].join("\n");

    const result = runChangedLinesCoverageCheck({
      policy,
      diff,
      lcov: ""
    });

    expect(result.evaluation_status).toBe("pass");
    expect(result.overall_status).toBe("pass");
    expect(result.summary).toEqual({
      changed_source_lines: 0,
      executable_changed_lines: 0,
      covered_lines: 0,
      uncovered_lines: 0,
      missing_coverage_lines: 0,
      non_measurable_lines: 0,
      coverage_percent: 100
    });
    expect(result.files).toEqual([]);
  });
});
