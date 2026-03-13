import { execFile as execFileCallback } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { createDefaultPolicyConfig } from "../src/core/contracts/policy.js";
import {
  formatChangedLinesCoverageReport,
  runChangedLinesCoverageCheck
} from "../src/core/diagnostics/changedLinesCoverage.js";

const execFile = promisify(execFileCallback);
const EMPTY_GIT_SHA = "0000000000000000000000000000000000000000";

interface ScriptOptions {
  repo_root?: string;
  lcov_file?: string;
  report_file?: string;
  base_ref?: string;
  head_ref?: string;
}

interface GitRange {
  base_ref: string;
  head_ref: string;
  diff_range: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(options.repo_root ?? process.cwd());
  const lcovFile = resolve(repoRoot, options.lcov_file ?? join("coverage", "lcov.info"));
  const reportFile = resolve(
    repoRoot,
    options.report_file ?? join(".specforge", "ci", "changed-lines-coverage-report.txt")
  );
  const range = await resolveGitRange(options);
  const [diff, lcov] = await Promise.all([
    readChangedSourceDiff(repoRoot, range.diff_range),
    readOptionalFile(lcovFile)
  ]);

  const result = runChangedLinesCoverageCheck({
    policy: createDefaultPolicyConfig().coverage,
    diff,
    lcov,
    repo_root: repoRoot,
    base_ref: range.base_ref,
    head_ref: range.head_ref
  });
  const report = formatChangedLinesCoverageReport(result);

  process.stdout.write(report);
  await writeReport(reportFile, report);

  if (result.overall_status === "fail") {
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const nextValue = argv[index + 1];

    if (!nextValue) {
      continue;
    }

    if (token === "--repo-root") {
      options.repo_root = nextValue;
      index += 1;
      continue;
    }

    if (token === "--lcov-file") {
      options.lcov_file = nextValue;
      index += 1;
      continue;
    }

    if (token === "--report-file") {
      options.report_file = nextValue;
      index += 1;
      continue;
    }

    if (token === "--base-ref") {
      options.base_ref = nextValue;
      index += 1;
      continue;
    }

    if (token === "--head-ref") {
      options.head_ref = nextValue;
      index += 1;
    }
  }

  return options;
}

async function resolveGitRange(options: ScriptOptions): Promise<GitRange> {
  if (options.base_ref && options.head_ref) {
    return {
      base_ref: options.base_ref,
      head_ref: options.head_ref,
      diff_range: `${options.base_ref}...${options.head_ref}`
    };
  }

  const eventPayload = await readGithubEventPayload();

  if (isPullRequestPayload(eventPayload)) {
    const baseRef = eventPayload.pull_request.base.sha;
    const headRef = eventPayload.pull_request.head.sha;

    return {
      base_ref: baseRef,
      head_ref: headRef,
      diff_range: `${baseRef}...${headRef}`
    };
  }

  if (isPushPayload(eventPayload) && eventPayload.before !== EMPTY_GIT_SHA) {
    return {
      base_ref: eventPayload.before,
      head_ref: eventPayload.after,
      diff_range: `${eventPayload.before}..${eventPayload.after}`
    };
  }

  return {
    base_ref: "HEAD^",
    head_ref: "HEAD",
    diff_range: "HEAD^..HEAD"
  };
}

async function readChangedSourceDiff(repoRoot: string, diffRange: string): Promise<string> {
  const { stdout } = await execFile(
    "git",
    ["diff", "--unified=0", "--no-color", diffRange, "--", "src"],
    {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024
    }
  );

  return stdout;
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function writeReport(path: string, report: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, report, "utf8");
}

async function readGithubEventPayload(): Promise<unknown | undefined> {
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!eventPath) {
    return undefined;
  }

  try {
    const contents = await readFile(eventPath, "utf8");
    return JSON.parse(contents);
  } catch {
    return undefined;
  }
}

function isPullRequestPayload(
  value: unknown
): value is { pull_request: { base: { sha: string }; head: { sha: string } } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "pull_request" in value &&
    typeof value.pull_request === "object" &&
    value.pull_request !== null &&
    typeof value.pull_request.base === "object" &&
    value.pull_request.base !== null &&
    typeof value.pull_request.head === "object" &&
    value.pull_request.head !== null &&
    typeof value.pull_request.base.sha === "string" &&
    typeof value.pull_request.head.sha === "string"
  );
}

function isPushPayload(value: unknown): value is { before: string; after: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { before?: unknown }).before === "string" &&
    typeof (value as { after?: unknown }).after === "string"
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
