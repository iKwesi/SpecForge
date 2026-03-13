import { describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import type { DoctorResult } from "../../src/core/diagnostics/doctor.js";

function buildDoctorResult(overrides: Partial<DoctorResult> = {}): DoctorResult {
  return {
    overall_status: "pass",
    checks: [
      {
        id: "node_version",
        label: "Node.js runtime",
        status: "pass",
        message: "Node.js 22.3.0 satisfies the minimum runtime requirement."
      }
    ],
    summary: {
      passed: 1,
      failed: 0
    },
    ...overrides
  };
}

describe("sf doctor command", () => {
  it("writes the doctor report and exits cleanly on success", async () => {
    let stdout = "";

    const exitCode = await runCli(["node", "sf", "doctor"], {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        }
      },
      doctor_runner: async () => buildDoctorResult()
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("SpecForge Doctor");
    expect(stdout).toContain("PASS node_version");
  });

  it("returns exit code 1 when doctor detects blocking failures", async () => {
    const exitCode = await runCli(["node", "sf", "doctor"], {
      stdout: {
        write() {
          return true;
        }
      },
      doctor_runner: async () =>
        buildDoctorResult({
          overall_status: "fail",
          checks: [
            {
              id: "git_binary",
              label: "Git binary",
              status: "fail",
              message: "git was not found on PATH.",
              remediation: "Install git and ensure it is available on PATH."
            }
          ],
          summary: {
            passed: 0,
            failed: 1
          }
        })
    });

    expect(exitCode).toBe(1);
  });
});
