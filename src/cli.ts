import { Command } from "commander";
import { pathToFileURL } from "node:url";

import {
  formatDoctorReport,
  runDoctor,
  type DoctorResult,
  type RunDoctorInput
} from "./core/diagnostics/doctor.js";

interface CliWriter {
  write(chunk: string): boolean | void;
}

export interface CliDependencies {
  stdout?: CliWriter;
  stderr?: CliWriter;
  doctor_runner?: (input?: RunDoctorInput) => Promise<DoctorResult>;
  doctor_input?: RunDoctorInput;
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
  const doctorRunner = dependencies.doctor_runner ?? runDoctor;
  const doctorInput = dependencies.doctor_input;
  const program = new Command();

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

    throw error;
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv);
  } catch (error) {
    const stderr = process.stderr;
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
