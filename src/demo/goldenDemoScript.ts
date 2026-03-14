import { join } from "node:path";

import { runGoldenDemo } from "./goldenDemo.js";

interface ScriptIo {
  stdout: {
    write(chunk: string): boolean | void;
  };
  stderr: {
    write(chunk: string): boolean | void;
  };
}

export async function runGoldenDemoScript(
  args: string[],
  io: ScriptIo = {
    stdout: process.stdout,
    stderr: process.stderr
  }
): Promise<number> {
  try {
    const workspaceRoot = parseWorkspaceRootArgument(args);
    const result = await runGoldenDemo({
      workspace_root: workspaceRoot
    });

    io.stdout.write("SpecForge Golden Demo\n\n");
    io.stdout.write(`Workspace Root: ${result.workspace_root}\n`);
    io.stdout.write(`Repository Root: ${result.repository_root}\n`);
    io.stdout.write(`Artifact Root: ${result.artifact_root}\n`);
    io.stdout.write(`Manifest: ${result.manifest_path}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseWorkspaceRootArgument(args: string[]): string {
  const workspaceFlagIndex = args.indexOf("--workspace-root");
  if (workspaceFlagIndex < 0) {
    return join(process.cwd(), ".tmp", "golden-demo");
  }

  const explicitWorkspaceRoot = args[workspaceFlagIndex + 1];
  if (!explicitWorkspaceRoot || explicitWorkspaceRoot.startsWith("-")) {
    throw new Error("--workspace-root requires a directory path value.");
  }

  return explicitWorkspaceRoot;
}
