import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  InspectError,
  formatInspectReport,
  runInspect
} from "../../src/core/diagnostics/inspect.js";

interface RepoFile {
  path: string;
  content: string;
}

async function writeRepoFiles(root: string, files: RepoFile[]): Promise<void> {
  for (const file of files) {
    const absolutePath = join(root, file.path);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, file.content, "utf8");
  }
}

describe("runInspect failure paths", () => {
  it("fails with a typed error when repository profiling fails", async () => {
    const missingRoot = join(tmpdir(), "specforge-inspect-missing", String(Date.now()));

    await expect(
      runInspect({
        repository_root: missingRoot
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<InspectError>>({
        code: "profile_failed"
      })
    );
  });
});

describe("runInspect success paths", () => {
  it("produces repo profile and architecture artifacts without modifying application files", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-inspect-"));

    await writeRepoFiles(repoRoot, [
      { path: "package.json", content: "{\"name\":\"demo\"}" },
      { path: "tsconfig.json", content: "{\"compilerOptions\":{}}" },
      { path: "src/api/routes.ts", content: "export const routes = [];" },
      { path: "src/api/service.ts", content: "export const service = {};" },
      { path: "src/cli/main.ts", content: "export const main = () => {};" },
      { path: "README.md", content: "# Demo\n" }
    ]);

    const originalReadme = await readFile(join(repoRoot, "README.md"), "utf8");
    const result = await runInspect({
      repository_root: repoRoot,
      created_timestamp: new Date("2026-03-13T23:59:00.000Z")
    });

    expect(result.repo_profile.kind).toBe("repo_profile");
    expect(result.architecture_summary.kind).toBe("architecture_summary");
    expect(result.repo_profile.metadata.generator).toBe("operation.profileRepository");
    expect(result.architecture_summary.metadata.generator).toBe(
      "operation.mapArchitectureFromRepo"
    );
    expect(result.repo_profile_path).toBe(join(repoRoot, ".specforge", "repo_profile.json"));
    expect(result.architecture_summary_path).toBe(
      join(repoRoot, ".specforge", "architecture_summary.json")
    );
    expect(result.architecture_summary.subsystems.map((subsystem) => subsystem.id)).toEqual([
      "src/api",
      "src/cli"
    ]);

    expect(await readFile(join(repoRoot, "README.md"), "utf8")).toBe(originalReadme);
    expect((await readdir(repoRoot)).sort((left, right) => left.localeCompare(right))).toEqual([
      ".specforge",
      "package.json",
      "README.md",
      "src",
      "tsconfig.json"
    ]);

    const report = formatInspectReport(result);
    expect(report).toContain("SpecForge Inspect");
    expect(report).toContain("repo_profile@v1");
    expect(report).toContain("architecture_summary@v1");
    expect(report).toContain("src/api");
  });

  it("supports bounded deep inspection by increasing the scan budget", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-inspect-"));

    await writeRepoFiles(
      repoRoot,
      Array.from({ length: 250 }, (_, index) => ({
        path: `src/file-${index.toString().padStart(3, "0")}.ts`,
        content: `export const value${index} = ${index};\n`
      }))
    );

    const standard = await runInspect({
      repository_root: repoRoot
    });
    const deep = await runInspect({
      repository_root: repoRoot,
      deep: true
    });

    expect(standard.scan_mode).toBe("standard");
    expect(standard.repo_profile.scan.max_files).toBe(200);
    expect(standard.repo_profile.scan.truncated).toBe(true);

    expect(deep.scan_mode).toBe("deep");
    expect(deep.repo_profile.scan.max_files).toBe(1000);
    expect(deep.repo_profile.scan.truncated).toBe(false);
  });

  it("reports planned artifact writes without publishing artifacts when dry_run is enabled", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-inspect-dry-run-"));

    await writeRepoFiles(repoRoot, [
      { path: "package.json", content: "{\"name\":\"demo\"}" },
      { path: "src/api/routes.ts", content: "export const routes = [];" },
      { path: "src/api/service.ts", content: "export const service = {};" }
    ]);

    const result = await runInspect({
      repository_root: repoRoot,
      dry_run: true,
      created_timestamp: new Date("2026-03-14T00:10:00.000Z")
    });

    expect(result.dry_run).toEqual({
      enabled: true,
      changes: [
        {
          status: "planned",
          kind: "artifact_write",
          target: join(repoRoot, ".specforge", "repo_profile.json"),
          detail: "Would publish repo_profile artifact metadata without mutating the repository."
        },
        {
          status: "planned",
          kind: "artifact_write",
          target: join(repoRoot, ".specforge", "architecture_summary.json"),
          detail: "Would publish architecture_summary artifact metadata without mutating the repository."
        }
      ]
    });
    expect((await readdir(repoRoot)).sort((left, right) => left.localeCompare(right))).toEqual([
      "package.json",
      "src"
    ]);

    const report = formatInspectReport(result);
    expect(report).toContain("Dry Run: enabled");
    expect(report).toContain("Would publish repo_profile artifact metadata");
  });

  it("can generate maintained architecture docs from inspect artifacts when explicitly requested", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-inspect-docs-"));

    await writeRepoFiles(repoRoot, [
      { path: "package.json", content: "{\"name\":\"demo\"}" },
      { path: "src/api/routes.ts", content: "export const routes = [];" },
      { path: "src/api/service.ts", content: "export const service = {};" },
      { path: "docs/ARCHITECTURE.md", content: "# SpecForge Architecture\n\nManual intro.\n" }
    ]);

    const result = await runInspect({
      repository_root: repoRoot,
      write_architecture_docs: true,
      created_timestamp: new Date("2026-03-14T00:20:00.000Z")
    });

    expect(result.architecture_summary_markdown_path).toBe(
      join(repoRoot, ".specforge", "architecture_summary.md")
    );
    expect(result.architecture_docs_path).toBe(join(repoRoot, "docs", "ARCHITECTURE.md"));
    expect(await readFile(result.architecture_summary_markdown_path!, "utf8")).toContain(
      "## Artifact Flow"
    );
    expect(await readFile(result.architecture_docs_path!, "utf8")).toContain(
      "<!-- specforge:begin generated-architecture -->"
    );

    const report = formatInspectReport(result);
    expect(report).toContain("Architecture Docs Path");
    expect(report).toContain("Architecture Summary Markdown Path");
  });
});
