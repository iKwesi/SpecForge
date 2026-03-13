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
  const program = new Command();

  program.exitOverride();

  program
    .name("specforge")
    .description("Specification-driven engineering orchestration CLI")
    .version("0.1.0");

  program
    .command("start")
    .description("Start a SpecForge run (scaffold placeholder)")
    .action(() => {
      stdout.write("SpecForge CLI scaffold ready.\n");
    });

  program
    .command("doctor")
    .description("Check environment, tooling, repository, and policy readiness")
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
    .description("Render deterministic explanations grounded in artifact, policy, and scheduler evidence")
    .option(
      "--artifact-file <path>",
      "Path to an artifact JSON file to explain",
      collectOptionValues,
      []
    )
    .option("--policy-file <path>", "Path to a policy JSON file")
    .option("--schedule-file <path>", "Path to a scheduler JSON file")
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
