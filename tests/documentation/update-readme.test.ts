import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  UpdateReadmeError,
  runUpdateReadme
} from "../../src/core/operations/updateReadme.js";
import {
  ARTIFACT_OWNERSHIP_REGISTRY,
  inferArtifactKindFromId
} from "../../src/core/spec/ownership.js";

async function writeReadme(repoRoot: string, content: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await writeFile(join(repoRoot, "README.md"), content, "utf8");
}

describe("updateReadme failure paths", () => {
  it("fails closed when repository ownership is not owned", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-readme-external-"));

    await expect(
      runUpdateReadme({
        project_mode: "existing-repo",
        repository_ownership: "external",
        repository_root: repoRoot,
        section_id: "specforge-status",
        section_title: "SpecForge Status",
        section_body: "Managed section body."
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<UpdateReadmeError>>({
        code: "invalid_ownership"
      })
    );
  });

  it("fails when the README contains malformed managed-section markers", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-readme-malformed-"));

    await writeReadme(
      repoRoot,
      [
        "# Demo",
        "",
        "<!-- specforge:managed-section:specforge-status:start -->",
        "## SpecForge Status",
        "",
        "Old body."
      ].join("\n")
    );

    await expect(
      runUpdateReadme({
        project_mode: "existing-repo",
        repository_ownership: "owned",
        repository_root: repoRoot,
        section_id: "specforge-status",
        section_title: "SpecForge Status",
        section_body: "Managed section body."
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<UpdateReadmeError>>({
        code: "invalid_readme_state"
      })
    );
  });
});

describe("updateReadme success paths", () => {
  it("appends a managed section while preserving unrelated README content", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-readme-append-"));

    await writeReadme(
      repoRoot,
      [
        "# Demo",
        "",
        "Welcome to the project.",
        "",
        "## Installation",
        "",
        "Run pnpm install."
      ].join("\n")
    );

    const result = await runUpdateReadme({
      project_mode: "existing-repo",
      repository_ownership: "owned",
      repository_root: repoRoot,
      artifact_dir: repoRoot,
      section_id: "specforge-status",
      section_title: "SpecForge Status",
      section_body: [
        "This repository is managed through SpecForge operations.",
        "",
        "- Artifacts live under .specforge/",
        "- Use specforge inspect before planning changes."
      ].join("\n"),
      created_timestamp: new Date("2026-03-14T02:30:00.000Z")
    });

    const readmeOnDisk = await readFile(join(repoRoot, "README.md"), "utf8");
    expect(readmeOnDisk).toContain("# Demo");
    expect(readmeOnDisk).toContain("## Installation");
    expect(readmeOnDisk).toContain("Run pnpm install.");
    expect(readmeOnDisk).toContain("<!-- specforge:managed-section:specforge-status:start -->");
    expect(readmeOnDisk).toContain("## SpecForge Status");
    expect(readmeOnDisk).toContain("Use specforge inspect before planning changes.");

    expect(result.readme_update_result.change_status).toBe("updated");
    expect(result.readme_update_result.metadata.artifact_id).toBe("readme_update_result.readme");
    expect(result.readme_update_result.metadata.artifact_version).toBe("v1");
    expect(result.readme_update_result.diff_preview).toContain("+ <!-- specforge:managed-section:specforge-status:start -->");

    const artifactOnDisk = JSON.parse(
      await readFile(join(repoRoot, ".specforge", "readme", "update_result.json"), "utf8")
    );
    expect(artifactOnDisk.metadata.artifact_id).toBe("readme_update_result.readme");
    expect(artifactOnDisk.change_status).toBe("updated");
  });

  it("replaces only the managed section body and preserves surrounding manual content", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-readme-replace-"));

    await writeReadme(
      repoRoot,
      [
        "# Demo",
        "",
        "Intro paragraph.",
        "",
        "<!-- specforge:managed-section:specforge-status:start -->",
        "## SpecForge Status",
        "",
        "Old generated content.",
        "<!-- specforge:managed-section:specforge-status:end -->",
        "",
        "## Maintainers",
        "",
        "Humans own this section."
      ].join("\n")
    );

    const result = await runUpdateReadme({
      project_mode: "existing-repo",
      repository_ownership: "owned",
      repository_root: repoRoot,
      artifact_dir: repoRoot,
      section_id: "specforge-status",
      section_title: "SpecForge Status",
      section_body: "New generated content.",
      created_timestamp: new Date("2026-03-14T02:35:00.000Z")
    });

    const readmeOnDisk = await readFile(join(repoRoot, "README.md"), "utf8");
    expect(readmeOnDisk).toContain("Intro paragraph.");
    expect(readmeOnDisk).toContain("## Maintainers");
    expect(readmeOnDisk).toContain("Humans own this section.");
    expect(readmeOnDisk).toContain("New generated content.");
    expect(readmeOnDisk).not.toContain("Old generated content.");
    expect(result.readme_update_result.diff_preview).toContain("- Old generated content.");
    expect(result.readme_update_result.diff_preview).toContain("+ New generated content.");
  });

  it("increments the result artifact version on subsequent runs and registers ownership", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-readme-version-"));

    await writeReadme(repoRoot, "# Demo\n");

    await runUpdateReadme({
      project_mode: "existing-repo",
      repository_ownership: "owned",
      repository_root: repoRoot,
      artifact_dir: repoRoot,
      section_id: "specforge-status",
      section_title: "SpecForge Status",
      section_body: "First body.",
      created_timestamp: new Date("2026-03-14T02:40:00.000Z")
    });

    const second = await runUpdateReadme({
      project_mode: "existing-repo",
      repository_ownership: "owned",
      repository_root: repoRoot,
      artifact_dir: repoRoot,
      section_id: "specforge-status",
      section_title: "SpecForge Status",
      section_body: "Second body.",
      created_timestamp: new Date("2026-03-14T02:45:00.000Z")
    });

    expect(second.readme_update_result.metadata.artifact_version).toBe("v2");
    expect(second.readme_update_result.metadata.parent_version).toBe("v1");
    expect(ARTIFACT_OWNERSHIP_REGISTRY.readme_update_result.owner_operation).toBe(
      "operation.updateReadme"
    );
    expect(inferArtifactKindFromId("readme_update_result.readme")).toBe("readme_update_result");
  });

  it("reports planned README updates without mutating files in dry_run mode", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-readme-dry-run-"));

    await writeReadme(repoRoot, "# Demo\n");

    const before = await readFile(join(repoRoot, "README.md"), "utf8");
    const result = await runUpdateReadme({
      project_mode: "existing-repo",
      repository_ownership: "owned",
      repository_root: repoRoot,
      artifact_dir: repoRoot,
      section_id: "specforge-status",
      section_title: "SpecForge Status",
      section_body: "Dry-run body.",
      dry_run: true,
      created_timestamp: new Date("2026-03-14T02:50:00.000Z")
    });

    expect(result.dry_run).toEqual({
      enabled: true,
      changes: [
        {
          status: "planned",
          kind: "file_write",
          target: join(repoRoot, "README.md"),
          detail: "Would update the managed README section without rewriting unrelated content."
        },
        {
          status: "planned",
          kind: "artifact_write",
          target: join(repoRoot, ".specforge", "readme", "update_result.json"),
          detail: "Would publish a versioned readme_update_result artifact."
        }
      ]
    });

    expect(await readFile(join(repoRoot, "README.md"), "utf8")).toBe(before);
  });
});
