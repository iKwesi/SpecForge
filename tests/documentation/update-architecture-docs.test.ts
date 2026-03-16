import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  UpdateArchitectureDocsError,
  runUpdateArchitectureDocs
} from "../../src/core/operations/updateArchitectureDocs.js";
import type { ArchitectureSummaryArtifact } from "../../src/core/operations/mapArchitectureFromRepo.js";
import type { RepoProfileArtifact } from "../../src/core/operations/profileRepository.js";

function buildRepoProfile(repositoryRoot: string): RepoProfileArtifact {
  return {
    kind: "repo_profile",
    metadata: {
      artifact_id: "repo_profile",
      artifact_version: "v1",
      created_timestamp: "2026-03-14T12:00:00.000Z",
      generator: "operation.profileRepository",
      source_refs: [],
      checksum: "a".repeat(64)
    },
    project_mode: "existing-repo",
    repository_root: repositoryRoot,
    scan: {
      max_files: 200,
      scanned_file_count: 4,
      truncated: false,
      ignored_directories: [".git", ".specforge"]
    },
    evidence: {
      top_level_entries: ["README.md", "docs", "src"],
      sampled_files: [
        "src/api/routes.ts",
        "src/api/service.ts",
        "src/cli/main.ts",
        "tests/api/routes.test.ts"
      ],
      extension_counts: [
        { extension: ".test.ts", count: 1 },
        { extension: ".ts", count: 3 }
      ],
      detected_manifests: ["package.json"],
      detected_tooling: ["node", "typescript", "vitest"]
    }
  };
}

function buildArchitectureSummary(repositoryRoot: string): ArchitectureSummaryArtifact {
  return {
    kind: "architecture_summary",
    metadata: {
      artifact_id: "architecture_summary",
      artifact_version: "v2",
      created_timestamp: "2026-03-14T12:05:00.000Z",
      generator: "operation.mapArchitectureFromRepo",
      source_refs: [{ artifact_id: "repo_profile", artifact_version: "v1" }],
      checksum: "b".repeat(64)
    },
    project_mode: "existing-repo",
    repository_root: repositoryRoot,
    subsystems: [
      {
        id: "src/api",
        label: "src/api",
        inferred_responsibility: "API/backend surface",
        file_count: 2,
        evidence_refs: ["src/api/routes.ts", "src/api/service.ts"],
        uncertainty: "low"
      },
      {
        id: "src/cli",
        label: "src/cli",
        inferred_responsibility: "CLI entrypoints",
        file_count: 1,
        evidence_refs: ["src/cli/main.ts"],
        uncertainty: "medium"
      },
      {
        id: "tests/api",
        label: "tests/api",
        inferred_responsibility: "Test coverage",
        file_count: 1,
        evidence_refs: ["tests/api/routes.test.ts"],
        uncertainty: "medium"
      }
    ],
    summary_markdown: "# Architecture Summary"
  };
}

describe("updateArchitectureDocs failure paths", () => {
  it("rejects a missing repository root before attempting any generated writes", async () => {
    const missingRoot = join(tmpdir(), "specforge-architecture-docs-missing", String(Date.now()));

    await expect(
      runUpdateArchitectureDocs({
        project_mode: "existing-repo",
        repository_root: missingRoot,
        repo_profile: buildRepoProfile(missingRoot),
        architecture_summary: buildArchitectureSummary(missingRoot)
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<UpdateArchitectureDocsError>>({
        code: "repository_not_found"
      })
    );
  });

  it("rejects mismatched repository roots between repo_profile and architecture_summary", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-architecture-docs-"));

    await expect(
      runUpdateArchitectureDocs({
        project_mode: "existing-repo",
        repository_root: repoRoot,
        repo_profile: buildRepoProfile(repoRoot),
        architecture_summary: buildArchitectureSummary(join(repoRoot, "other"))
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<UpdateArchitectureDocsError>>({
        code: "artifact_mismatch"
      })
    );
  });

  it("rejects duplicate managed section markers instead of updating an ambiguous docs file", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-architecture-docs-"));
    const docsDir = join(repoRoot, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      join(docsDir, "ARCHITECTURE.md"),
      [
        "# SpecForge Architecture",
        "",
        "<!-- specforge:begin generated-architecture -->",
        "old one",
        "<!-- specforge:end generated-architecture -->",
        "",
        "<!-- specforge:begin generated-architecture -->",
        "old two",
        "<!-- specforge:end generated-architecture -->"
      ].join("\n"),
      "utf8"
    );

    await expect(
      runUpdateArchitectureDocs({
        project_mode: "existing-repo",
        repository_root: repoRoot,
        repo_profile: buildRepoProfile(repoRoot),
        architecture_summary: buildArchitectureSummary(repoRoot)
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<UpdateArchitectureDocsError>>({
        code: "invalid_docs_state"
      })
    );
  });

  it("rejects docs_path values that resolve outside repository_root", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-architecture-docs-"));

    await expect(
      runUpdateArchitectureDocs({
        project_mode: "existing-repo",
        repository_root: repoRoot,
        repo_profile: buildRepoProfile(repoRoot),
        architecture_summary: buildArchitectureSummary(repoRoot),
        docs_path: "../outside/ARCHITECTURE.md"
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<UpdateArchitectureDocsError>>({
        code: "invalid_docs_path"
      })
    );
  });
});

describe("updateArchitectureDocs success paths", () => {
  it("writes a generated summary markdown file and a managed docs/ARCHITECTURE.md section", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-architecture-docs-"));
    const docsDir = join(repoRoot, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      join(docsDir, "ARCHITECTURE.md"),
      "# SpecForge Architecture\n\nManual overview.\n",
      "utf8"
    );

    const result = await runUpdateArchitectureDocs({
      project_mode: "existing-repo",
      repository_root: repoRoot,
      repo_profile: buildRepoProfile(repoRoot),
      architecture_summary: buildArchitectureSummary(repoRoot)
    });

    expect(result.architecture_summary_markdown_path).toBe(
      join(repoRoot, ".specforge", "architecture_summary.md")
    );
    expect(result.architecture_docs_path).toBe(join(repoRoot, "docs", "ARCHITECTURE.md"));
    expect(result.architecture_summary_markdown).toContain("# Architecture Summary");
    expect(result.architecture_summary_markdown).toContain("## Artifact Flow");
    expect(result.architecture_summary_markdown).toContain("## System Context Diagram");
    expect(result.architecture_summary_markdown).toContain("## Subsystem Relationship Diagram");
    expect(result.architecture_summary_markdown).toContain("operation.profileRepository");
    expect(result.architecture_summary_markdown).toContain("src/api/routes.ts");
    expect(result.architecture_summary_markdown).toMatch(
      /src_cli__[a-z0-9]{6} --> src_api__[a-z0-9]{6}/
    );
    expect(result.architecture_summary_markdown).toMatch(
      /tests_api__[a-z0-9]{6} -.-> src_api__[a-z0-9]{6}/
    );

    const docsContent = await readFile(result.architecture_docs_path, "utf8");
    expect(docsContent).toContain("Manual overview.");
    expect(docsContent).toContain("<!-- specforge:begin generated-architecture -->");
    expect(docsContent).toContain("## Repository Evidence Snapshot");
    expect(docsContent).toContain("## System Context Diagram");
    expect(docsContent).toContain("## Subsystem Relationship Diagram");
    expect(docsContent).toContain("### Subsystem: src/api");
    expect(docsContent).toContain("### Contracts");
    expect(docsContent).toContain("### Artifact Flow");

    const summaryContent = await readFile(result.architecture_summary_markdown_path, "utf8");
    expect(summaryContent).toBe(`${result.architecture_summary_markdown}\n`);
  });

  it("replaces only the managed generated section and preserves surrounding manual bytes", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-architecture-docs-"));
    const docsDir = join(repoRoot, "docs");
    const docsPath = join(docsDir, "ARCHITECTURE.md");
    await mkdir(docsDir, { recursive: true });
    const before = [
      "# SpecForge Architecture",
      "",
      "Manual intro.",
      "",
      "```ts",
      "  preserve indentation exactly",
      "```",
      ""
    ].join("\n");
    const after = [
      "",
      "Manual appendix:",
      "  keep this indentation too",
      ""
    ].join("\n");
    await writeFile(
      docsPath,
      `${before}<!-- specforge:begin generated-architecture -->\nold generated section\n<!-- specforge:end generated-architecture -->${after}`,
      "utf8"
    );

    const result = await runUpdateArchitectureDocs({
      project_mode: "existing-repo",
      repository_root: repoRoot,
      repo_profile: buildRepoProfile(repoRoot),
      architecture_summary: buildArchitectureSummary(repoRoot)
    });

    expect(result.architecture_docs_content.startsWith(before)).toBe(true);
    expect(result.architecture_docs_content.endsWith(after)).toBe(true);
    expect(result.architecture_docs_content).not.toContain("old generated section");
    expect(result.architecture_docs_content).toContain("<!-- specforge:begin generated-architecture -->");
  });

  it("is idempotent when rerun against an already-generated architecture docs file", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-architecture-docs-"));
    const docsDir = join(repoRoot, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      join(docsDir, "ARCHITECTURE.md"),
      "# SpecForge Architecture\n\nManual overview.\n",
      "utf8"
    );

    const first = await runUpdateArchitectureDocs({
      project_mode: "existing-repo",
      repository_root: repoRoot,
      repo_profile: buildRepoProfile(repoRoot),
      architecture_summary: buildArchitectureSummary(repoRoot)
    });
    const firstContent = await readFile(first.architecture_docs_path, "utf8");

    const second = await runUpdateArchitectureDocs({
      project_mode: "existing-repo",
      repository_root: repoRoot,
      repo_profile: buildRepoProfile(repoRoot),
      architecture_summary: buildArchitectureSummary(repoRoot)
    });
    const secondContent = await readFile(second.architecture_docs_path, "utf8");

    expect(secondContent).toBe(firstContent);
    expect(second.architecture_docs_content).toBe(first.architecture_docs_content);
  });

  it("resolves relative docs_path values from repository_root instead of process cwd", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-architecture-docs-"));

    const result = await runUpdateArchitectureDocs({
      project_mode: "existing-repo",
      repository_root: repoRoot,
      repo_profile: buildRepoProfile(repoRoot),
      architecture_summary: buildArchitectureSummary(repoRoot),
      docs_path: "docs/generated/ARCHITECTURE.generated.md"
    });

    expect(result.architecture_docs_path).toBe(
      join(repoRoot, "docs", "generated", "ARCHITECTURE.generated.md")
    );
    expect(await readFile(result.architecture_docs_path, "utf8")).toContain(
      "<!-- specforge:begin generated-architecture -->"
    );
  });

  it("allows repo-relative docs_path names that start with two dots but stay inside the repository", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-architecture-docs-"));

    const result = await runUpdateArchitectureDocs({
      project_mode: "existing-repo",
      repository_root: repoRoot,
      repo_profile: buildRepoProfile(repoRoot),
      architecture_summary: buildArchitectureSummary(repoRoot),
      docs_path: "..docs/ARCHITECTURE.md"
    });

    expect(result.architecture_docs_path).toBe(join(repoRoot, "..docs", "ARCHITECTURE.md"));
    expect(await readFile(result.architecture_docs_path, "utf8")).toContain(
      "<!-- specforge:begin generated-architecture -->"
    );
  });

  it("supports dry-run mode without mutating the repository", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-architecture-docs-dry-run-"));

    const result = await runUpdateArchitectureDocs({
      project_mode: "existing-repo",
      repository_root: repoRoot,
      repo_profile: buildRepoProfile(repoRoot),
      architecture_summary: buildArchitectureSummary(repoRoot),
      dry_run: true
    });

    expect(result.dry_run).toEqual({
      enabled: true,
      changes: [
        {
          status: "planned",
          kind: "file_write",
          target: join(repoRoot, ".specforge", "architecture_summary.md"),
          detail: "Would publish generated architecture summary markdown from inspect artifacts."
        },
        {
          status: "planned",
          kind: "file_write",
          target: join(repoRoot, "docs", "ARCHITECTURE.md"),
          detail: "Would update the managed generated-architecture section in the target architecture docs file."
        }
      ]
    });
    expect(await readdir(repoRoot)).toEqual([]);
  });
});
