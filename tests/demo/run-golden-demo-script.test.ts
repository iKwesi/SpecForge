import { describe, expect, it } from "vitest";

import { runGoldenDemoScript } from "../../src/demo/goldenDemoScript.js";

describe("golden demo script", () => {
  it("prints a clean error and returns exit code 1 for unsafe workspace roots", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await runGoldenDemoScript(["--workspace-root", process.cwd()], {
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

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("workspace_root must");
  });
});
