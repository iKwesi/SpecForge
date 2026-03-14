import { describe, expect, it } from "vitest";

import { createDefaultPolicyConfig } from "../../src/core/contracts/policy.js";
import { formatDoctorReport, runDoctor, type DoctorCommandRunner } from "../../src/core/diagnostics/doctor.js";

function createRunner(
  responses: Record<string, { stdout?: string; stderr?: string; error?: Error }>
): DoctorCommandRunner {
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    const response = responses[key];
    if (!response) {
      throw new Error(`Unexpected command: ${key}`);
    }

    if (response.error) {
      throw response.error;
    }

    return {
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? ""
    };
  };
}

describe("runDoctor failure paths", () => {
  it("reports deterministic remediation when required tooling is missing", async () => {
    const result = await runDoctor({
      cwd: "/workspace/specforge",
      node_version: "v20.11.1",
      command_runner: createRunner({
        "git --version": { error: new Error("git missing") },
        "pnpm --version": { error: new Error("pnpm missing") }
      })
    });

    expect(result.overall_status).toBe("fail");
    expect(result.summary).toEqual({
      passed: 1,
      failed: 4
    });
    expect(result.checks).toEqual([
      expect.objectContaining({
        id: "node_version",
        status: "fail",
        remediation: "Install Node.js 22 LTS or newer and re-run sf doctor."
      }),
      expect.objectContaining({
        id: "git_binary",
        status: "fail",
        remediation: "Install git and ensure it is available on PATH."
      }),
      expect.objectContaining({
        id: "pnpm_binary",
        status: "fail",
        remediation: "Install pnpm and ensure it is available on PATH."
      }),
      expect.objectContaining({
        id: "repository_root",
        status: "fail",
        remediation: "Initialize or open a git repository before running execution commands."
      }),
      expect.objectContaining({
        id: "policy_config",
        status: "pass"
      })
    ]);
  });

  it("reports actionable policy validation errors when the config shape is invalid", async () => {
    const result = await runDoctor({
      cwd: "/workspace/specforge",
      node_version: "v22.3.0",
      command_runner: createRunner({
        "git --version": { stdout: "git version 2.47.0\n" },
        "pnpm --version": { stdout: "10.31.0\n" },
        "git rev-parse --show-toplevel": { stdout: "/workspace/specforge\n" }
      }),
      policy: {
        ...createDefaultPolicyConfig(),
        parallelism: {
          max_concurrent_tasks: 0,
          serialize_on_uncertainty: true
        }
      }
    });

    expect(result.overall_status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "policy_config",
          status: "fail",
          message: expect.stringContaining("parallelism.max_concurrent_tasks"),
          remediation: expect.stringContaining("docs/POLICY_CONFIG.md")
        })
      ])
    );
  });
});

describe("runDoctor success paths", () => {
  it("passes environment, repository, and policy checks with stable report formatting", async () => {
    const result = await runDoctor({
      cwd: "/workspace/specforge",
      node_version: "v22.3.0",
      command_runner: createRunner({
        "git --version": { stdout: "git version 2.47.0\n" },
        "pnpm --version": { stdout: "10.31.0\n" },
        "git rev-parse --show-toplevel": { stdout: "/workspace/specforge\n" }
      }),
      policy: createDefaultPolicyConfig()
    });

    expect(result.overall_status).toBe("pass");
    expect(result.summary).toEqual({
      passed: 5,
      failed: 0
    });

    expect(formatDoctorReport(result)).toContain("SpecForge Doctor");
    expect(formatDoctorReport(result)).toContain("PASS node_version");
    expect(formatDoctorReport(result)).toContain("PASS repository_root");
    expect(formatDoctorReport(result)).toContain("Summary: 5 passed, 0 failed");
  });
});
