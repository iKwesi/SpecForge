import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  GitProviderError,
  createNativeGitProvider,
  resolveGitProvider
} from "../../src/core/git/provider.js";

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createRepository(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "specforge-git-provider-"));

  await runGit(["init"], repoRoot);
  await runGit(["checkout", "-b", "main"], repoRoot);
  await runGit(["config", "user.name", "SpecForge Tests"], repoRoot);
  await runGit(["config", "user.email", "specforge@example.com"], repoRoot);

  await writeFile(join(repoRoot, "README.md"), "# SpecForge test repo\n", "utf8");
  await runGit(["add", "README.md"], repoRoot);
  await runGit(["commit", "-m", "init"], repoRoot);

  return repoRoot;
}

describe("git provider resolution", () => {
  it("resolves native-git by default when git is available", async () => {
    const resolution = await resolveGitProvider();

    expect(resolution.selected_provider).toBe("native-git");
    expect(resolution.fallback_used).toBe(false);
    expect(resolution.provider.name).toBe("native-git");
    expect(resolution.provider.capabilities.worktree).toBe(true);
  });

  it("falls back to native-git when the preferred gitbutler adapter is unavailable", async () => {
    const resolution = await resolveGitProvider({
      preferred_provider: "gitbutler"
    });

    expect(resolution.selected_provider).toBe("native-git");
    expect(resolution.fallback_used).toBe(true);
    expect(resolution.fallback_reason).toBe("preferred_provider_unavailable");
  });
});

describe("native git provider branch and worktree primitives", () => {
  it("reads the current branch and can create and checkout a branch", async () => {
    const repoRoot = await createRepository();
    const provider = createNativeGitProvider();

    expect(await provider.getCurrentBranch({ repo_root: repoRoot })).toBe("main");

    await provider.createBranch({
      repo_root: repoRoot,
      branch_name: "feat/task-1",
      start_point: "HEAD"
    });

    expect(await runGit(["branch", "--list", "feat/task-1"], repoRoot)).toContain("feat/task-1");

    await provider.checkoutBranch({
      repo_root: repoRoot,
      branch_name: "feat/task-1"
    });

    expect(await provider.getCurrentBranch({ repo_root: repoRoot })).toBe("feat/task-1");
  });

  it("adds and removes worktrees through the provider interface", async () => {
    const repoRoot = await createRepository();
    const provider = createNativeGitProvider();
    const worktreePath = join(tmpdir(), `specforge-worktree-${Date.now()}`);

    await provider.addWorktree({
      repo_root: repoRoot,
      worktree_path: worktreePath,
      branch_name: "feat/task-2",
      start_point: "HEAD",
      create_branch: true
    });

    const normalizedWorktreePath = await realpath(worktreePath);
    const worktrees = await provider.listWorktrees({ repo_root: repoRoot });
    expect(worktrees.some((worktree) => worktree.path === normalizedWorktreePath)).toBe(true);
    expect(worktrees.find((worktree) => worktree.path === normalizedWorktreePath)?.branch_name).toBe(
      "feat/task-2"
    );

    await writeFile(join(worktreePath, "WORKTREE.md"), "worktree content\n", "utf8");
    await runGit(["add", "WORKTREE.md"], worktreePath);
    await runGit(["commit", "-m", "worktree commit"], worktreePath);

    await provider.removeWorktree({
      repo_root: repoRoot,
      worktree_path: worktreePath,
      force: true
    });

    const updatedWorktrees = await provider.listWorktrees({ repo_root: repoRoot });
    expect(updatedWorktrees.some((worktree) => worktree.path === normalizedWorktreePath)).toBe(false);
  });

  it("fails with a typed error when branch names are invalid", async () => {
    const repoRoot = await createRepository();
    const provider = createNativeGitProvider();

    await expect(
      provider.createBranch({
        repo_root: repoRoot,
        branch_name: "",
        start_point: "HEAD"
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GitProviderError>>({
        code: "invalid_branch_name"
      })
    );
  });

  it("surfaces typed repository errors for missing repositories", async () => {
    const provider = createNativeGitProvider();

    await expect(
      provider.getCurrentBranch({ repo_root: "/tmp/specforge-missing-repo" })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GitProviderError>>({
        code: "repository_not_found"
      })
    );
  });
});
