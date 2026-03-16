import { Command } from "commander";
import { pathToFileURL } from "node:url";

import {
  formatDoctorReport,
  runDoctor,
  type DoctorResult,
  type RunDoctorInput
} from "./core/diagnostics/doctor.js";
import {
  formatExplainReport,
  runExplain,
  type ExplainResult,
  type RunExplainInput
} from "./core/diagnostics/explain.js";
import {
  formatInspectReport,
  runInspect,
  type InspectResult,
  type RunInspectInput
} from "./core/diagnostics/inspect.js";
import {
  formatStatusReport,
  runStatus,
  type RunStatusInput,
  type StatusResult
} from "./core/diagnostics/status.js";
import { createWebhookStatusNotifier } from "./core/notifiers/statusNotifiers.js";
import { ISSUE_TRACKER_PROVIDER_NAMES } from "./core/trackers/contracts.js";

interface CliWriter {
  write(chunk: string): boolean | void;
}

export interface CliDependencies {
  stdout?: CliWriter;
  stderr?: CliWriter;
  doctor_runner?: (input?: RunDoctorInput) => Promise<DoctorResult>;
  doctor_input?: RunDoctorInput;
  explain_runner?: (input: RunExplainInput) => Promise<ExplainResult>;
  explain_input?: Partial<RunExplainInput>;
  inspect_runner?: (input?: RunInspectInput) => Promise<InspectResult>;
  inspect_input?: Partial<RunInspectInput>;
  status_runner?: (input: RunStatusInput) => Promise<StatusResult>;
  status_input?: Partial<RunStatusInput>;
}

class CliExitSignal extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`CLI exited with code ${exitCode}`);
    this.name = "CliExitSignal";
    this.exitCode = exitCode;
  }
}

export function createProgram(dependencies: CliDependencies = {}): Command {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const doctorRunner = dependencies.doctor_runner ?? runDoctor;
  const doctorInput = dependencies.doctor_input;
  const explainRunner = dependencies.explain_runner ?? runExplain;
  const explainInput = dependencies.explain_input;
  const inspectRunner = dependencies.inspect_runner ?? runInspect;
  const inspectInput = dependencies.inspect_input;
  const statusRunner = dependencies.status_runner ?? runStatus;
  const statusInput = dependencies.status_input;
  const program = new Command();

  program.exitOverride();

  program
    .name("specforge")
    .description("Specification-driven engineering orchestration CLI for turning ideas and repositories into disciplined, artifact-driven workflows. Workflow guide: run 'specforge doctor' to validate readiness, 'specforge inspect' to generate repository profile and architecture summary artifacts, and 'specforge explain' to trace artifact lineage with deterministic evidence.")
    .usage("<command> [options]")
    .version("0.1.0")
    .addHelpText(
      "after",
      `
Examples:
  $ specforge doctor
    Validate local tooling, repository readiness, and contribution prerequisites.

  $ specforge inspect --repository-root . --artifact-dir .
    Scan an existing repository and emit bounded architecture artifacts for planning.

  $ specforge explain --artifact-file .specforge/task-results/TASK-1.json
    Explain an artifact using deterministic evidence from related inputs.

  $ specforge status --repo iKwesi/SpecForge --pr 123
    Report review-request state and CI outcomes from the configured issue tracker.

Workflow guide:
  1. Run 'specforge doctor' before making changes to confirm your environment is ready.
  2. Run 'specforge inspect' to profile a repository and generate architecture artifacts.
  3. Run 'specforge explain' when you need traceable reasoning for generated artifacts.
  4. Run 'specforge status' to inspect pull request and CI state after handoff.

Artifacts:
  - 'inspect' writes repository profile and architecture summary artifacts.
  - 'explain' reads one or more artifact files plus optional policy/schedule evidence.
  - 'status' reads review-request state and status checks from the configured issue tracker.
  - 'doctor' reports readiness and exits non-zero when blocking issues are found.
`
    );

  program
    .command("start")
    .description("Start a SpecForge run (scaffold placeholder)")
    .addHelpText(
      "after",
      `
Examples:
  $ specforge start

Use this placeholder command when wiring future workflow entrypoints.
`
    )
    .action(() => {
      stdout.write("SpecForge CLI scaffold ready.\n");
    });

  program
    .command("doctor")
    .description("Check environment, tooling, repository, and policy readiness before starting work. Example: specforge doctor")
    .addHelpText(
      "after",
      `
Examples:
  $ specforge doctor

What it checks:
  - runtime/tooling availability
  - repository and policy readiness
  - blocking issues that should be fixed before a run or PR

Exit behavior:
  - exits 0 when the environment is ready
  - exits 1 when blocking failures are detected
`
    )
    .action(async () => {
      const result = await doctorRunner({
        cwd: process.cwd(),
        ...(doctorInput ?? {})
      });

      stdout.write(formatDoctorReport(result));

      if (result.overall_status === "fail") {
        throw new CliExitSignal(1);
      }
    });

  program
    .command("explain")
    .description("Render deterministic explanations grounded in artifact, policy, and scheduler evidence. Use this when you need traceable reasoning tied to artifact lineage. Example: specforge explain --artifact-file .specforge/task-results/TASK-1.json")
    .option(
      "--artifact-file <path>",
      "Path to an artifact JSON file to explain (repeat to include multiple artifacts)",
      collectOptionValues,
      []
    )
    .option("--policy-file <path>", "Path to a policy JSON file used as supporting evidence")
    .option("--schedule-file <path>", "Path to a scheduler JSON file used as supporting evidence")
    .addHelpText(
      "after",
      `
Examples:
  $ specforge explain --artifact-file .specforge/task-results/TASK-1.json
  $ specforge explain --artifact-file a.json --artifact-file b.json --policy-file policy.json

Use this command when you need a human-readable explanation tied to artifact lineage.
The command reads artifact inputs and optional policy/schedule context, then prints an evidence-based report.
`
    )
    .action(async (options: { artifactFile: string[]; policyFile?: string; scheduleFile?: string }) => {
      try {
        const result = await explainRunner({
          artifact_files: options.artifactFile,
          ...(options.policyFile ? { policy_file: options.policyFile } : {}),
          ...(options.scheduleFile ? { schedule_file: options.scheduleFile } : {}),
          ...(explainInput ?? {})
        });

        stdout.write(formatExplainReport(result));
      } catch (error) {
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        throw new CliExitSignal(1);
      }
    });

  program
    .command("status")
    .description("Report issue-tracker review request state and CI outcomes. Example: specforge status --repo iKwesi/SpecForge --pr 123")
    .requiredOption("--pr <ref>", "Pull request or merge request number, URL, or branch to inspect")
    .option(
      "--repo <path>",
      "Issue tracker repository/project path when --pr is not a review request URL"
    )
    .option(
      "--provider <name>",
      `Issue tracker provider (${ISSUE_TRACKER_PROVIDER_NAMES.join(" or ")})`
    )
    .option(
      "--notify-webhook <url>",
      "Emit the status event to a webhook; delivery failures are reported without failing the status command, but invalid webhook configuration is still an error",
      collectOptionValues,
      []
    )
    .addHelpText(
      "after",
      `
Examples:
  $ specforge status --repo iKwesi/SpecForge --pr 123
  $ specforge status --pr https://github.com/iKwesi/SpecForge/pull/123
  $ specforge status --provider gitlab --repo gitlab-org/cli --pr 42
  $ specforge status --repo iKwesi/SpecForge --pr 123 --notify-webhook https://hooks.example.test/specforge

Use this after handoff when you need the latest review-request merge state and status checks.
`
    )
    .action(async (options: { pr: string; repo?: string; provider?: string; notifyWebhook: string[] }) => {
      try {
        const provider = normalizeIssueTrackerProvider(options.provider);
        const result = await statusRunner({
          pull_request: options.pr,
          ...(options.repo ? { repository: options.repo } : {}),
          ...(provider ? { provider } : {}),
          ...(options.notifyWebhook.length > 0
            ? {
                notifiers: options.notifyWebhook.map((webhookUrl, index) =>
                  createWebhookStatusNotifier({
                    webhook_url: webhookUrl,
                    adapter_id: options.notifyWebhook.length > 1 ? `webhook-${index + 1}` : "webhook"
                  })
                )
              }
            : {}),
          ...(statusInput ?? {})
        });

        stdout.write(formatStatusReport(result));
      } catch (error) {
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        throw new CliExitSignal(1);
      }
    });

  program
    .command("inspect")
    .description("Profile a repository and map bounded architecture outputs without touching application code. Produces a repository profile artifact and an architecture summary artifact in a .specforge subdirectory. Example: specforge inspect --repository-root . --artifact-dir .")
    .option("--repository-root <path>", "Repository root to inspect (defaults to the current working directory)")
    .option(
      "--artifact-dir <path>",
      "Parent/output directory under which the .specforge artifact directory will be created"
    )
    .option("--deep", "Increase the bounded scan budget for deeper repository inspection")
    .option("--dry-run", "Report planned artifact writes without publishing them")
    .option(
      "--write-architecture-docs",
      "Generate maintained architecture markdown from the inspect artifacts"
    )
    .option(
      "--docs-path <path>",
      "Optional docs/ARCHITECTURE.md target when --write-architecture-docs is enabled"
    )
    .addHelpText(
      "after",
      `
Examples:
  $ specforge inspect
  $ specforge inspect --repository-root ../my-repo --artifact-dir ../my-repo --deep
  $ specforge inspect --repository-root . --dry-run
  $ specforge inspect --repository-root . --write-architecture-docs

What it produces:
  - a repository profile artifact
  - an architecture summary artifact
  - optional maintained architecture markdown when explicitly requested

Use this before planning or task decomposition when you need a bounded view of an existing codebase.
`
    )
    .action(
      async (options: {
        repositoryRoot?: string;
        artifactDir?: string;
        deep?: boolean;
        dryRun?: boolean;
        writeArchitectureDocs?: boolean;
        docsPath?: string;
      }) => {
        try {
          const result = await inspectRunner({
            repository_root: options.repositoryRoot ?? process.cwd(),
            ...(options.artifactDir ? { artifact_dir: options.artifactDir } : {}),
            ...(options.deep ? { deep: true } : {}),
            ...(options.dryRun ? { dry_run: true } : {}),
            ...(options.writeArchitectureDocs ? { write_architecture_docs: true } : {}),
            ...(options.docsPath ? { docs_path: options.docsPath } : {}),
            ...(inspectInput ?? {})
          });

          stdout.write(formatInspectReport(result));
        } catch (error) {
          stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
          throw new CliExitSignal(1);
        }
      }
    );

  return program;
}

export async function runCli(argv: string[] = process.argv, dependencies: CliDependencies = {}): Promise<number> {
  const program = createProgram(dependencies);

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CliExitSignal) {
      return error.exitCode;
    }

    if (error instanceof Error) {
      (dependencies.stderr ?? process.stderr).write(`${error.message}\n`);
      return 1;
    }

    (dependencies.stderr ?? process.stderr).write(`${String(error)}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

function collectOptionValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function normalizeIssueTrackerProvider(
  value: string | undefined
): "github" | "gitlab" | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (ISSUE_TRACKER_PROVIDER_NAMES.includes(value as "github" | "gitlab")) {
    return value as "github" | "gitlab";
  }

  throw new Error(
    `provider must be one of ${ISSUE_TRACKER_PROVIDER_NAMES.join(", ")}.`
  );
}
