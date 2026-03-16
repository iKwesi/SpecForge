import { execFile } from "node:child_process";
import { cp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { runCli, type CliDependencies } from "../cli.js";
import type { StatusResult } from "../core/diagnostics/status.js";
import { runBuildContextPack } from "../core/operations/buildContextPack.js";
import { runCriticRalphLoop } from "../core/operations/criticRalphLoop.js";
import { runDecomposeToWorkGraph } from "../core/operations/decomposeToWorkGraph.js";
import { runDevTddTask } from "../core/operations/devTDDTask.js";
import { runGeneratePrd } from "../core/operations/generatePRD.js";
import { runGenerateSpecPack } from "../core/operations/generateSpecPack.js";
import { runIdeaInterview, type IdeaBucketId } from "../core/operations/ideaInterview.js";

const execFileAsync = promisify(execFile);
const TEMPLATE_REPOSITORY_ROOT = fileURLToPath(
  new URL("../../examples/golden-demo/repository-template", import.meta.url)
);
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const DEMO_TIMESTAMPS = {
  inspect: new Date("2026-03-14T10:00:00.000Z"),
  idea_interview: new Date("2026-03-14T10:05:00.000Z"),
  prd: new Date("2026-03-14T10:10:00.000Z"),
  spec_pack: new Date("2026-03-14T10:15:00.000Z"),
  work_graph: new Date("2026-03-14T10:20:00.000Z"),
  context_pack: new Date("2026-03-14T10:25:00.000Z"),
  execution: new Date("2026-03-14T10:30:00.000Z"),
  critic: new Date("2026-03-14T10:35:00.000Z")
} as const;

export interface GoldenDemoArtifactSummary {
  artifact_id: string;
  version: string;
  path: string;
}

export interface GoldenDemoManifest {
  scenario_id: "golden-demo.existing-repo";
  workspace_root: string;
  repository_root: string;
  artifact_root: string;
  command_outputs: GoldenDemoResult["command_outputs"];
  artifacts: GoldenDemoResult["artifacts"];
}

export interface GoldenDemoResult {
  workspace_root: string;
  repository_root: string;
  artifact_root: string;
  manifest_path: string;
  command_outputs: {
    doctor: string;
    inspect: string;
    explain: string;
    status: string;
  };
  artifacts: {
    repo_profile: GoldenDemoArtifactSummary;
    architecture_summary: GoldenDemoArtifactSummary;
    idea_brief: GoldenDemoArtifactSummary;
    prd_md: GoldenDemoArtifactSummary;
    prd_json: GoldenDemoArtifactSummary;
    spec_md: GoldenDemoArtifactSummary;
    spec_index: GoldenDemoArtifactSummary;
    context_pack: GoldenDemoArtifactSummary;
    task_execution_result: GoldenDemoArtifactSummary;
    critic_result: GoldenDemoArtifactSummary;
  };
}

export interface RunGoldenDemoInput {
  workspace_root: string;
}

export class GoldenDemoError extends Error {
  readonly code: "unsafe_workspace_root";

  constructor(message: string) {
    super(message);
    this.name = "GoldenDemoError";
    this.code = "unsafe_workspace_root";
  }
}

/**
 * Execute the canonical SpecForge demo against a small existing-repo fixture.
 *
 * The demo intentionally uses real CLI commands where they already exist and real
 * operation entrypoints for the remaining artifact chain. GitHub status output is
 * simulated so the demo stays deterministic and runnable without live PR state.
 */
export async function runGoldenDemo(input: RunGoldenDemoInput): Promise<GoldenDemoResult> {
  const workspaceRoot = await resolveWorkspaceRoot(input.workspace_root);
  const repositoryRoot = join(workspaceRoot, "repository");
  const artifactRoot = join(workspaceRoot, "artifacts");
  const manifestPath = join(workspaceRoot, "golden-demo-manifest.json");

  await resetWorkspace(workspaceRoot);
  await copyFixtureRepository(repositoryRoot);
  await initializeGitRepository(repositoryRoot);
  await mkdir(artifactRoot, { recursive: true });

  const doctor = await captureSuccessfulCli(["node", "sf", "doctor"], {
    doctor_input: {
      cwd: repositoryRoot
    }
  });

  const inspect = await captureSuccessfulCli(
    [
      "node",
      "sf",
      "inspect",
      "--repository-root",
      repositoryRoot,
      "--artifact-dir",
      artifactRoot
    ],
    {
      inspect_input: {
        created_timestamp: DEMO_TIMESTAMPS.inspect
      }
    }
  );

  const ideaInterview = await runIdeaInterview({
    project_mode: "existing-repo",
    answers: buildIdeaAnswers(),
    artifact_dir: artifactRoot,
    created_timestamp: DEMO_TIMESTAMPS.idea_interview
  });

  if (!ideaInterview.artifact) {
    throw new Error("Golden demo expected ideaInterview to publish idea_brief.json.");
  }

  const prd = await runGeneratePrd({
    project_mode: "existing-repo",
    idea_brief: ideaInterview.artifact,
    idea_brief_status: "approved",
    artifact_dir: artifactRoot,
    created_timestamp: DEMO_TIMESTAMPS.prd
  });

  const specPack = await runGenerateSpecPack({
    project_mode: "existing-repo",
    idea_brief: ideaInterview.artifact,
    prd_json: prd.prd_json,
    artifact_dir: artifactRoot,
    created_timestamp: DEMO_TIMESTAMPS.spec_pack
  });
  const acceptanceArtifact = {
    kind: "acceptance_markdown" as const,
    metadata: specPack.acceptance_artifact.metadata,
    source_refs: specPack.acceptance_artifact.source_refs,
    path: specPack.acceptance_artifact.path,
    content: specPack.acceptance_artifact.content
  };
  const schemaArtifact = {
    kind: "schema_json" as const,
    metadata: specPack.schema_artifact.metadata,
    source_refs: specPack.schema_artifact.source_refs,
    path: specPack.schema_artifact.path,
    content: specPack.schema_artifact.content
  };

  const workGraph = await runDecomposeToWorkGraph({
    project_mode: "existing-repo",
    prd_json: prd.prd_json,
    spec_artifact: specPack.spec_artifact,
    acceptance_artifact: acceptanceArtifact,
    schema_artifact: schemaArtifact,
    created_timestamp: DEMO_TIMESTAMPS.work_graph
  });

  const contextPack = await runBuildContextPack({
    project_mode: "existing-repo",
    task_id: "TASK-1",
    work_graph: workGraph.work_graph,
    prd_json: prd.prd_json,
    spec_artifact: specPack.spec_artifact,
    acceptance_artifact: acceptanceArtifact,
    schema_artifact: schemaArtifact,
    artifact_dir: artifactRoot,
    created_timestamp: DEMO_TIMESTAMPS.context_pack
  });

  const taskExecution = await runDevTddTask({
    project_mode: "existing-repo",
    context_pack: contextPack.context_pack,
    branch_ref: "feat/golden-demo-task-1",
    phases: [
      {
        phase: "red",
        status: "failed",
        summary: "Recorded a failing acceptance-focused test for the first bounded task.",
        evidence: ["tests/api/orders.test.ts"],
        commands: ["pnpm test -- --run tests/api/orders.test.ts"]
      },
      {
        phase: "green",
        status: "passed",
        summary: "Recorded the minimal implementation needed to satisfy the task.",
        evidence: ["src/api/service.ts", "tests/api/orders.test.ts"],
        commands: ["pnpm test -- --run tests/api/orders.test.ts"]
      },
      {
        phase: "refactor",
        status: "passed",
        summary: "Recorded a cleanup pass that preserved the passing task state.",
        evidence: ["src/api/service.ts"],
        commands: ["pnpm test -- --run tests/api/orders.test.ts", "pnpm typecheck"]
      }
    ],
    artifact_dir: artifactRoot,
    created_timestamp: DEMO_TIMESTAMPS.execution
  });

  const critic = await runCriticRalphLoop({
    project_mode: "existing-repo",
    task_execution_result: taskExecution.task_execution_result,
    attempt_number: 1,
    max_attempts: 2,
    critic_checks: [
      {
        check_id: "tests_passed",
        passed: true,
        detail: "The bounded task transcript ends in a passing state."
      },
      {
        check_id: "acceptance_covered",
        passed: true,
        detail: "Acceptance evidence is present in the context pack and task transcript."
      },
      {
        check_id: "scope_respected",
        passed: true,
        detail: "The task remained within the scoped API and CLI surfaces."
      }
    ],
    artifact_dir: artifactRoot,
    created_timestamp: DEMO_TIMESTAMPS.critic
  });

  const explain = await captureSuccessfulCli(
    [
      "node",
      "sf",
      "explain",
      "--artifact-file",
      join(artifactRoot, ".specforge", "task-results", "TASK-1.json")
    ],
    {}
  );

  const status = await captureSuccessfulCli(
    ["node", "sf", "status", "--repo", "iKwesi/SpecForge", "--pr", "38"],
    {
      // The golden demo proves the CLI/reporting contract without depending on live GitHub state.
      status_runner: async () => buildSimulatedStatusResult()
    }
  );

  const result: GoldenDemoResult = {
    workspace_root: workspaceRoot,
    repository_root: repositoryRoot,
    artifact_root: artifactRoot,
    manifest_path: manifestPath,
    command_outputs: {
      doctor,
      inspect,
      explain,
      status
    },
    artifacts: {
      repo_profile: summarizeArtifact(
        specArtifactPath(artifactRoot, ".specforge", "repo_profile.json"),
        "repo_profile",
        "v1"
      ),
      architecture_summary: summarizeArtifact(
        specArtifactPath(artifactRoot, ".specforge", "architecture_summary.json"),
        "architecture_summary",
        "v1"
      ),
      idea_brief: summarizeArtifact(
        join(artifactRoot, "idea_brief.json"),
        ideaInterview.artifact.metadata.artifact_id,
        ideaInterview.artifact.metadata.artifact_version
      ),
      prd_md: summarizeArtifact(
        join(artifactRoot, "PRD.md"),
        prd.prd_md.metadata.artifact_id,
        prd.prd_md.metadata.artifact_version
      ),
      prd_json: summarizeArtifact(
        join(artifactRoot, "PRD.json"),
        prd.prd_json.metadata.artifact_id,
        prd.prd_json.metadata.artifact_version
      ),
      spec_md: summarizeArtifact(
        join(artifactRoot, "SPEC.md"),
        specPack.spec_md.metadata.artifact_id,
        specPack.spec_md.metadata.artifact_version
      ),
      spec_index: summarizeArtifact(
        join(artifactRoot, "spec", "index.json"),
        specPack.spec_index.metadata.artifact_id,
        specPack.spec_index.metadata.artifact_version
      ),
      context_pack: summarizeArtifact(
        join(artifactRoot, ".specforge", "context-packs", "TASK-1.json"),
        contextPack.context_pack.metadata.artifact_id,
        contextPack.context_pack.metadata.artifact_version
      ),
      task_execution_result: summarizeArtifact(
        join(artifactRoot, ".specforge", "task-results", "TASK-1.json"),
        taskExecution.task_execution_result.metadata.artifact_id,
        taskExecution.task_execution_result.metadata.artifact_version
      ),
      critic_result: summarizeArtifact(
        join(artifactRoot, ".specforge", "critic-results", "TASK-1.json"),
        critic.critic_result.metadata.artifact_id,
        critic.critic_result.metadata.artifact_version
      )
    }
  };

  const manifest = createGoldenDemoManifest(result);

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return result;
}

async function resetWorkspace(workspaceRoot: string): Promise<void> {
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
}

async function resolveWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const resolvedWorkspaceRoot = await resolvePlannedPath(workspaceRoot);
  const projectRoot = await resolvePlannedPath(PROJECT_ROOT);
  const processRoot = await resolvePlannedPath(process.cwd());
  const projectTmpRoot = await resolvePlannedPath(join(process.cwd(), "tmp"));
  const projectDotTmpRoot = await resolvePlannedPath(join(process.cwd(), ".tmp"));
  const osTmpRoot = await resolvePlannedPath(tmpdir());

  if (isFilesystemRoot(resolvedWorkspaceRoot)) {
    throw new GoldenDemoError(
      "workspace_root must not be the filesystem root. Use a child directory under ./tmp, ./.tmp, or the OS temp directory."
    );
  }

  if (
    resolvedWorkspaceRoot === processRoot ||
    resolvedWorkspaceRoot === projectRoot ||
    resolvedWorkspaceRoot === projectTmpRoot ||
    resolvedWorkspaceRoot === projectDotTmpRoot ||
    resolvedWorkspaceRoot === osTmpRoot
  ) {
    throw new GoldenDemoError(
      "workspace_root must be a dedicated child directory under ./tmp, ./.tmp, or the OS temp directory."
    );
  }

  const allowedBases = [projectTmpRoot, projectDotTmpRoot, osTmpRoot];
  if (!allowedBases.some((base) => isStrictDescendant(base, resolvedWorkspaceRoot))) {
    throw new GoldenDemoError(
      "workspace_root must stay within ./tmp, ./.tmp, or the OS temp directory to avoid deleting unrelated files."
    );
  }

  return resolvedWorkspaceRoot;
}

async function resolvePlannedPath(path: string): Promise<string> {
  let current = resolve(path);
  const pendingSegments: string[] = [];

  while (true) {
    try {
      const existingPath = await realpath(current);
      return pendingSegments.reduce((accumulator, segment) => join(accumulator, segment), existingPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }

      const parent = dirname(current);
      if (parent === current) {
        return current;
      }

      pendingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

function isFilesystemRoot(path: string): boolean {
  return dirname(path) === path;
}

function isStrictDescendant(base: string, candidate: string): boolean {
  const relativePath = relative(base, candidate);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function createGoldenDemoManifest(result: GoldenDemoResult): GoldenDemoManifest {
  return {
    scenario_id: "golden-demo.existing-repo",
    workspace_root: ".",
    repository_root: relativizePathFromWorkspace(result.workspace_root, result.repository_root),
    artifact_root: relativizePathFromWorkspace(result.workspace_root, result.artifact_root),
    command_outputs: {
      doctor: normalizeDoctorReportForManifest(result.command_outputs.doctor, result.workspace_root),
      inspect: normalizeWorkspaceBoundText(result.command_outputs.inspect, result.workspace_root),
      explain: normalizeWorkspaceBoundText(result.command_outputs.explain, result.workspace_root),
      status: result.command_outputs.status
    },
    artifacts: Object.fromEntries(
      Object.entries(result.artifacts).map(([artifactKey, artifact]) => [
        artifactKey,
        {
          ...artifact,
          path: relativizePathFromWorkspace(result.workspace_root, artifact.path)
        }
      ])
    ) as GoldenDemoResult["artifacts"]
  };
}

function normalizeDoctorReportForManifest(report: string, workspaceRoot: string): string {
  const normalizedLines = report.split("\n").map((line) => {
    if (line.startsWith("PASS node_version - ")) {
      return "PASS node_version - Node.js satisfies the minimum runtime requirement.";
    }

    if (line.startsWith("PASS git_binary - ")) {
      return "PASS git_binary - Git binary detected.";
    }

    if (line.startsWith("PASS pnpm_binary - ")) {
      return "PASS pnpm_binary - pnpm package manager detected.";
    }

    if (line.startsWith("PASS repository_root - ")) {
      return "PASS repository_root - Git repository detected.";
    }

    return line;
  });

  return normalizeWorkspaceBoundText(normalizedLines.join("\n"), workspaceRoot);
}

function normalizeWorkspaceBoundText(text: string, workspaceRoot: string): string {
  const escapedWorkspaceRoot = escapeRegExp(workspaceRoot);
  return text.replace(new RegExp(escapedWorkspaceRoot, "g"), ".");
}

function relativizePathFromWorkspace(workspaceRoot: string, targetPath: string): string {
  if (!isAbsolute(targetPath)) {
    return targetPath;
  }

  const relativePath = relative(workspaceRoot, targetPath);
  return relativePath.length === 0 ? "." : relativePath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function copyFixtureRepository(repositoryRoot: string): Promise<void> {
  await cp(TEMPLATE_REPOSITORY_ROOT, repositoryRoot, { recursive: true });
}

async function initializeGitRepository(repositoryRoot: string): Promise<void> {
  try {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repositoryRoot, encoding: "utf8" });
  } catch {
    await execFileAsync("git", ["init"], { cwd: repositoryRoot, encoding: "utf8" });
    await execFileAsync("git", ["checkout", "-B", "main"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
  }
}

function buildIdeaAnswers(): Partial<Record<IdeaBucketId, string>> {
  return {
    outcome:
      "Extend the existing demo repository with a deterministic planning-to-execution walkthrough for a small API and CLI enhancement.",
    users_roles: "Maintainers need traceable planning artifacts; contributors need a bounded task they can execute safely.",
    non_goals: "Do not redesign the fixture repository, add live GitHub mutations, or introduce parallel execution behavior.",
    inputs:
      "Repository profile, architecture summary, one approved idea brief, and the existing API/CLI repository layout.",
    outputs:
      "PRD artifacts, a spec pack, a bounded work graph, one context pack, one task execution result, and one critic result.",
    workflow:
      "Inspect the repo, convert the idea into artifacts, decompose one bounded task, build a task-specific context pack, then record a TDD execution result.",
    interfaces:
      "CLI commands for doctor/inspect/explain/status plus JSON artifacts for PRD, SPEC, context packs, and task execution results.",
    quality_bar:
      "The workflow must stay deterministic, use explicit provenance, and keep each artifact versioned and reviewable.",
    safety_compliance:
      "No repository writes outside the fixture workspace, no live GitHub mutations, and no hidden retries.",
    failure_modes:
      "Missing repo evidence, invalid artifact lineage, and TDD transcripts that violate the RED/GREEN/REFACTOR contract.",
    evaluation:
      "The demo should generate stable artifacts and a manifest that downstream tests can use as a regression baseline.",
    operations:
      "Run with Node 22 and pnpm, initialize the fixture repo as git, and store generated artifacts under an isolated artifacts directory."
  };
}

async function captureSuccessfulCli(
  argv: string[],
  dependencies: CliDependencies
): Promise<string> {
  let stdout = "";
  let stderr = "";

  const exitCode = await runCli(argv, {
    ...dependencies,
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      }
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      }
    }
  });

  if (exitCode !== 0) {
    throw new Error(`Golden demo CLI command failed: ${argv.join(" ")}\n${stderr || stdout}`.trim());
  }

  return stdout;
}

function buildSimulatedStatusResult(): StatusResult {
  return {
    pull_request: {
      provider: "github",
      request_kind: "pull_request",
      number: 38,
      url: "https://github.com/iKwesi/SpecForge/pull/38",
      title: "demo: golden workflow baseline",
      state: "open",
      merge_state_status: "clean",
      head_branch: "feat/issue-38-golden-demo",
      base_branch: "main",
      linked_issue_numbers: [38],
      overall_status: "success",
      status_checks: [
        {
          name: "build",
          type: "check_run",
          status: "completed",
          conclusion: "success",
          workflow_name: "ci"
        },
        {
          name: "test",
          type: "check_run",
          status: "completed",
          conclusion: "success",
          workflow_name: "ci"
        }
      ]
    }
  };
}

function summarizeArtifact(path: string, artifactId: string, version: string): GoldenDemoArtifactSummary {
  return {
    artifact_id: artifactId,
    version,
    path
  };
}

function specArtifactPath(artifactRoot: string, ...segments: string[]): string {
  return join(artifactRoot, ...segments);
}
