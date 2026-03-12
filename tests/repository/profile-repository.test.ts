import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  ProfileRepositoryError,
  runProfileRepository
} from "../../src/core/operations/profileRepository.js";
import { ARTIFACT_OWNERSHIP_REGISTRY } from "../../src/core/spec/ownership.js";

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

describe("profileRepository failure paths", () => {
  it("fails with typed invalid_mode when project mode is not existing-repo", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-profile-"));

    await expect(
      runProfileRepository({
        project_mode: "greenfield",
        repository_root: repoRoot
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProfileRepositoryError>>({
        code: "invalid_mode"
      })
    );
  });

  it("fails with typed error when repository root does not exist", async () => {
    const missing = join(tmpdir(), "specforge-profile-missing", String(Date.now()));

    await expect(
      runProfileRepository({
        project_mode: "existing-repo",
        repository_root: missing
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProfileRepositoryError>>({
        code: "repository_not_found"
      })
    );
  });
});

describe("profileRepository success paths", () => {
  it("registers repo_profile ownership to operation.profileRepository", () => {
    expect(ARTIFACT_OWNERSHIP_REGISTRY.repo_profile.owner_operation).toBe(
      "operation.profileRepository"
    );
  });

  it("produces deterministic evidence profile with bounded scan and ignore rules", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-profile-"));

    await writeRepoFiles(repoRoot, [
      { path: "package.json", content: "{\"name\":\"demo\"}" },
      { path: "pnpm-lock.yaml", content: "lockfileVersion: '9.0'" },
      { path: "tsconfig.json", content: "{\"compilerOptions\":{}}" },
      { path: "go.mod", content: "module github.com/example/demo" },
      { path: "src/index.ts", content: "export const hello = 'world';" },
      { path: "backend/main.go", content: "package main" },
      { path: ".git/config", content: "[core]" },
      { path: "node_modules/pkg/index.js", content: "module.exports = {};" },
      { path: "dist/build.js", content: "console.log('bundle');" }
    ]);

    const result = await runProfileRepository({
      project_mode: "existing-repo",
      repository_root: repoRoot,
      created_timestamp: new Date("2026-03-12T19:10:00.000Z")
    });

    expect(result.repo_profile.kind).toBe("repo_profile");
    expect(result.repo_profile.metadata.artifact_id).toBe("repo_profile");
    expect(result.repo_profile.metadata.artifact_version).toBe("v1");
    expect(result.repo_profile.metadata.generator).toBe("operation.profileRepository");
    expect(result.repo_profile.metadata.created_timestamp).toBe("2026-03-12T19:10:00.000Z");

    expect(result.repo_profile.evidence.detected_tooling).toEqual([
      "go",
      "node",
      "pnpm",
      "typescript"
    ]);

    expect(result.repo_profile.evidence.sampled_files.some((file) => file.startsWith(".git/"))).toBe(
      false
    );
    expect(
      result.repo_profile.evidence.sampled_files.some((file) => file.startsWith("node_modules/"))
    ).toBe(false);
    expect(result.repo_profile.evidence.sampled_files.some((file) => file.startsWith("dist/"))).toBe(
      false
    );

    expect(result.repo_profile.scan.scanned_file_count).toBeGreaterThan(0);
    expect(result.repo_profile.scan.truncated).toBe(false);
  });

  it("enforces max_files scan bound and marks profile as truncated", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-profile-"));

    await writeRepoFiles(repoRoot, [
      { path: "src/a.ts", content: "export const a = 1;" },
      { path: "src/b.ts", content: "export const b = 1;" },
      { path: "src/c.ts", content: "export const c = 1;" },
      { path: "src/d.ts", content: "export const d = 1;" }
    ]);

    const result = await runProfileRepository({
      project_mode: "existing-repo",
      repository_root: repoRoot,
      max_files: 2
    });

    expect(result.repo_profile.scan.max_files).toBe(2);
    expect(result.repo_profile.scan.scanned_file_count).toBe(2);
    expect(result.repo_profile.scan.truncated).toBe(true);
    expect(result.repo_profile.evidence.sampled_files).toHaveLength(2);
  });

  it("writes .specforge/repo_profile.json and increments version on subsequent runs", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "specforge-profile-"));

    await writeRepoFiles(repoRoot, [{ path: "README.md", content: "# demo" }]);

    const first = await runProfileRepository({
      project_mode: "existing-repo",
      repository_root: repoRoot,
      created_timestamp: new Date("2026-03-12T19:20:00.000Z")
    });

    expect(first.repo_profile.metadata.artifact_version).toBe("v1");

    const second = await runProfileRepository({
      project_mode: "existing-repo",
      repository_root: repoRoot,
      created_timestamp: new Date("2026-03-12T19:25:00.000Z")
    });

    expect(second.repo_profile.metadata.artifact_version).toBe("v2");
    expect(second.repo_profile.metadata.parent_version).toBe("v1");

    const written = JSON.parse(
      await readFile(join(repoRoot, ".specforge", "repo_profile.json"), "utf8")
    );
    expect(written.metadata.artifact_id).toBe("repo_profile");
    expect(written.metadata.artifact_version).toBe("v2");
  });
});
