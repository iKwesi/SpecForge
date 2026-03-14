import { join } from "node:path";

import { runGoldenDemo } from "../src/demo/goldenDemo.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const workspaceFlagIndex = args.indexOf("--workspace-root");
  const workspaceRoot =
    workspaceFlagIndex >= 0 && args[workspaceFlagIndex + 1]
      ? args[workspaceFlagIndex + 1]
      : join(process.cwd(), ".tmp", "golden-demo");

  const result = await runGoldenDemo({
    workspace_root: workspaceRoot
  });

  process.stdout.write("SpecForge Golden Demo\n\n");
  process.stdout.write(`Workspace Root: ${result.workspace_root}\n`);
  process.stdout.write(`Repository Root: ${result.repository_root}\n`);
  process.stdout.write(`Artifact Root: ${result.artifact_root}\n`);
  process.stdout.write(`Manifest: ${result.manifest_path}\n`);
}

void main();
