import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createDefaultPolicyConfig } from "../src/core/contracts/policy.js";
import {
  formatCiPolicyReport,
  runCiPolicyCheck
} from "../src/core/diagnostics/ciPolicy.js";

async function main(): Promise<void> {
  const result = runCiPolicyCheck(createDefaultPolicyConfig());
  const report = formatCiPolicyReport(result);

  process.stdout.write(report);
  await writeReport(report);

  if (result.overall_status === "fail") {
    process.exitCode = 1;
  }
}

async function writeReport(report: string): Promise<void> {
  const outputDir = join(process.cwd(), ".specforge", "ci");
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "policy-report.txt"), report, "utf8");
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
