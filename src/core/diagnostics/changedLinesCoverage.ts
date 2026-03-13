import { isAbsolute, normalize, relative } from "node:path";

import type { CoveragePolicy } from "../contracts/policy.js";

export type ChangedLinesCoverageStatus = "pass" | "fail";

export interface ChangedLinesCoverageSummary {
  changed_source_lines: number;
  executable_changed_lines: number;
  covered_lines: number;
  uncovered_lines: number;
  missing_coverage_lines: number;
  non_measurable_lines: number;
  coverage_percent: number;
}

export interface ChangedLinesCoverageFileResult {
  path: string;
  changed_lines: number[];
  covered_lines: number[];
  uncovered_lines: number[];
  missing_coverage_lines: number[];
  non_measurable_lines: number[];
  coverage_percent: number;
}

export interface ChangedLinesCoverageResult {
  policy: CoveragePolicy;
  evaluation_status: ChangedLinesCoverageStatus;
  overall_status: ChangedLinesCoverageStatus;
  base_ref?: string;
  head_ref?: string;
  summary: ChangedLinesCoverageSummary;
  files: ChangedLinesCoverageFileResult[];
}

export interface RunChangedLinesCoverageCheckInput {
  policy: CoveragePolicy;
  diff: string;
  lcov: string;
  repo_root?: string;
  base_ref?: string;
  head_ref?: string;
}

/**
 * Evaluate coverage strictly against changed executable source lines.
 *
 * For v1 we scope this to `src/` files only so the signal stays grounded in the
 * core engine code we actually ship, while docs/tests/workflow edits remain out
 * of coverage enforcement.
 */
export function runChangedLinesCoverageCheck(
  input: RunChangedLinesCoverageCheckInput
): ChangedLinesCoverageResult {
  const changedLinesByFile = parseChangedLinesDiff(input.diff);
  const coverageByFile = parseLcov(input.lcov, input.repo_root);

  const files = [...changedLinesByFile.entries()]
    .filter(([path]) => isTrackedSourceFile(path))
    .map(([path, changedLines]) => {
      const coverageRecord = coverageByFile.get(path);

      if (!coverageRecord) {
        return buildFileResult(path, changedLines, [], [], changedLines, []);
      }

      const coveredLines: number[] = [];
      const uncoveredLines: number[] = [];
      const missingCoverageLines: number[] = [];
      const nonMeasurableLines: number[] = [];

      for (const lineNumber of changedLines) {
        const hitCount = coverageRecord.get(lineNumber);

        if (hitCount === undefined) {
          nonMeasurableLines.push(lineNumber);
          continue;
        }

        if (hitCount > 0) {
          coveredLines.push(lineNumber);
        } else {
          uncoveredLines.push(lineNumber);
        }
      }

      return buildFileResult(
        path,
        changedLines,
        coveredLines,
        uncoveredLines,
        missingCoverageLines,
        nonMeasurableLines
      );
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  const summary = files.reduce<ChangedLinesCoverageSummary>(
    (aggregate, file) => ({
      changed_source_lines: aggregate.changed_source_lines + file.changed_lines.length,
      executable_changed_lines:
        aggregate.executable_changed_lines + file.covered_lines.length + file.uncovered_lines.length,
      covered_lines: aggregate.covered_lines + file.covered_lines.length,
      uncovered_lines: aggregate.uncovered_lines + file.uncovered_lines.length,
      missing_coverage_lines: aggregate.missing_coverage_lines + file.missing_coverage_lines.length,
      non_measurable_lines: aggregate.non_measurable_lines + file.non_measurable_lines.length,
      coverage_percent: 0
    }),
    {
      changed_source_lines: 0,
      executable_changed_lines: 0,
      covered_lines: 0,
      uncovered_lines: 0,
      missing_coverage_lines: 0,
      non_measurable_lines: 0,
      coverage_percent: 100
    }
  );

  summary.coverage_percent =
    summary.executable_changed_lines === 0
      ? 100
      : roundCoveragePercent((summary.covered_lines / summary.executable_changed_lines) * 100);

  const evaluationStatus: ChangedLinesCoverageStatus =
    summary.uncovered_lines > 0 || summary.missing_coverage_lines > 0 ? "fail" : "pass";
  const overallStatus: ChangedLinesCoverageStatus =
    evaluationStatus === "fail" && input.policy.enforcement === "hard-block" ? "fail" : "pass";

  return {
    policy: input.policy,
    evaluation_status: evaluationStatus,
    overall_status: overallStatus,
    ...(input.base_ref ? { base_ref: input.base_ref } : {}),
    ...(input.head_ref ? { head_ref: input.head_ref } : {}),
    summary,
    files
  };
}

export function formatChangedLinesCoverageReport(result: ChangedLinesCoverageResult): string {
  const lines = [
    "SpecForge Changed-Lines Coverage",
    "",
    `Policy: ${result.policy.scope}/${result.policy.enforcement}`,
    ...(result.base_ref || result.head_ref
      ? [`Range: ${result.base_ref ?? "unknown"} -> ${result.head_ref ?? "unknown"}`]
      : []),
    `Evaluation: ${result.evaluation_status.toUpperCase()}`,
    `Enforcement: ${formatEnforcementStatus(result)}`,
    "",
    "Summary",
    `- changed_source_lines: ${result.summary.changed_source_lines}`,
    `- executable_changed_lines: ${result.summary.executable_changed_lines}`,
    `- covered_lines: ${result.summary.covered_lines}`,
    `- uncovered_lines: ${result.summary.uncovered_lines}`,
    `- missing_coverage_lines: ${result.summary.missing_coverage_lines}`,
    `- non_measurable_lines: ${result.summary.non_measurable_lines}`,
    `- coverage_percent: ${result.summary.coverage_percent}`,
    "",
    "Files"
  ];

  if (result.files.length === 0) {
    lines.push("- none");
  } else {
    for (const file of result.files) {
      lines.push(
        `- ${file.path}: covered=${file.covered_lines.length}, uncovered=${file.uncovered_lines.length}, missing=${file.missing_coverage_lines.length}, non_measurable=${file.non_measurable_lines.length}, coverage=${file.coverage_percent}`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function parseChangedLinesDiff(diff: string): Map<string, number[]> {
  const changedLinesByFile = new Map<string, Set<number>>();
  const lines = diff.split(/\r?\n/);
  let currentFile: string | undefined;
  let currentLine = 0;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      currentFile = normalizeDiffPath(line.slice(4));
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      const nextLineNumber = hunkMatch[1];

      if (!nextLineNumber) {
        continue;
      }

      currentLine = Number.parseInt(nextLineNumber, 10);
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const currentSet = changedLinesByFile.get(currentFile) ?? new Set<number>();
      currentSet.add(currentLine);
      changedLinesByFile.set(currentFile, currentSet);
      currentLine += 1;
      continue;
    }

    if (line.startsWith(" ") || (line.length > 0 && !line.startsWith("-") && !line.startsWith("\\"))) {
      currentLine += 1;
    }
  }

  return new Map(
    [...changedLinesByFile.entries()].map(([path, changedLines]) => [
      path,
      [...changedLines].sort((left, right) => left - right)
    ])
  );
}

function parseLcov(lcov: string, repoRoot?: string): Map<string, Map<number, number>> {
  const coverageByFile = new Map<string, Map<number, number>>();
  const lines = lcov.split(/\r?\n/);
  let currentFile: string | undefined;

  for (const line of lines) {
    if (line.startsWith("SF:")) {
      currentFile = normalizeCoveragePath(line.slice(3), repoRoot);
      continue;
    }

    if (line.startsWith("DA:") && currentFile) {
      const [lineNumberValue, hitCountValue] = line.slice(3).split(",", 2);

      if (!lineNumberValue || !hitCountValue) {
        continue;
      }

      const lineNumber = Number.parseInt(lineNumberValue, 10);
      const hitCount = Number.parseInt(hitCountValue, 10);

      if (Number.isNaN(lineNumber) || Number.isNaN(hitCount)) {
        continue;
      }

      const record = coverageByFile.get(currentFile) ?? new Map<number, number>();
      record.set(lineNumber, hitCount);
      coverageByFile.set(currentFile, record);
      continue;
    }

    if (line === "end_of_record") {
      currentFile = undefined;
    }
  }

  return coverageByFile;
}

function buildFileResult(
  path: string,
  changedLines: number[],
  coveredLines: number[],
  uncoveredLines: number[],
  missingCoverageLines: number[],
  nonMeasurableLines: number[]
): ChangedLinesCoverageFileResult {
  const executableChangedLines = coveredLines.length + uncoveredLines.length;

  return {
    path,
    changed_lines: [...changedLines],
    covered_lines: [...coveredLines],
    uncovered_lines: [...uncoveredLines],
    missing_coverage_lines: [...missingCoverageLines],
    non_measurable_lines: [...nonMeasurableLines],
    coverage_percent:
      executableChangedLines === 0
        ? 100
        : roundCoveragePercent((coveredLines.length / executableChangedLines) * 100)
  };
}

function formatEnforcementStatus(result: ChangedLinesCoverageResult): string {
  if (result.evaluation_status === "pass") {
    return "PASS";
  }

  return result.policy.enforcement === "report-only" ? "PASS (report-only)" : "FAIL (hard-block)";
}

function normalizeDiffPath(value: string): string | undefined {
  if (value === "/dev/null") {
    return undefined;
  }

  return normalizeRepoPath(value.replace(/^b\//, ""));
}

function normalizeCoveragePath(value: string, repoRoot?: string): string {
  if (repoRoot && isAbsolute(value)) {
    const relativePath = relative(repoRoot, value);
    return normalizeRepoPath(relativePath);
  }

  return normalizeRepoPath(value);
}

function normalizeRepoPath(value: string): string {
  return normalize(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

function isTrackedSourceFile(path: string): boolean {
  return path.startsWith("src/") && path.endsWith(".ts");
}

function roundCoveragePercent(value: number): number {
  return Math.round(value * 100) / 100;
}
