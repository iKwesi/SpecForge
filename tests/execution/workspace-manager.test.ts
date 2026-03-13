import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  TaskWorkspaceManagerError,
  cleanupTaskWorkspace,
  prepareTaskWorkspace
} from "../../src/core/execution/workspaceManager.js";
import { createNativeGitProvider } from "../../src/core/git/provider.js";

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createRepository(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "specforge-workspace-manager-repo-"));

  await runGit(["init"], repoRoot);
  await runGit(["checkout", "-b", "main"], repoRoot);
  await runGit(["config", "user.name", "SpecForge Tests"], repoRoot);
  await runGit(["config", "user.email", "specforge@example.com"], repoRoot);

  await writeFile(join(repoRoot, "README.md"), "# SpecForge test repo\n", "utf8");
  await runGit(["add", "README.md"], repoRoot);
  await runGit(["commit", "-m", "init"], repoRoot);

  return repoRoot;
}

describe("workspace manager", () => {
  it("creates a deterministic isolated worktree for a task", async () => {
    const repoRoot = await createRepository();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "specforge-workspaces-"));
    const provider = createNativeGitProvider();

    const result = await prepareTaskWorkspace({
      repo_root: repoRoot,
      workspace_root: workspaceRoot,
      task_id: "TASK-1",
      git_provider: provider
    });

    expect(result.branch_name).toBe("feat/task-1");
    expect(result.workspace_path).toBe(join(workspaceRoot, "task-1"));
    expect(result.created).toBe(true);
    expect(await runGit(["branch", "--show-current"], result.workspace_path)).toBe("feat/task-1");
  });

  it("reuses the same task workspace without creating a duplicate worktree", async () => {
    const repoRoot = await createRepository();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "specforge-workspaces-"));
    const provider = createNativeGitProvider();

    const first = await prepareTaskWorkspace({
      repo_root: repoRoot,
      workspace_root: workspaceRoot,
      task_id: "TASK-1",
      git_provider: provider
    });

    const second = await prepareTaskWorkspace({
      repo_root: repoRoot,
      workspace_root: workspaceRoot,
      task_id: "TASK-1",
      git_provider: provider
    });

    expect(second.created).toBe(false);
    expect(second.workspace_path).toBe(first.workspace_path);

    const worktrees = await provider.listWorktrees({ repo_root: repoRoot });
    expect(worktrees.filter((worktree) => worktree.branch_name === "feat/task-1")).toHaveLength(1);
  });

  it("recreates a cleaned task workspace even when the branch already exists", async () => {
    const repoRoot = await createRepository();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "specforge-workspaces-"));
    const provider = createNativeGitProvider();

    const first = await prepareTaskWorkspace({
      repo_root: repoRoot,
      workspace_root: workspaceRoot,
      task_id: "TASK-1",
      git_provider: provider
    });

    await cleanupTaskWorkspace({
      repo_root: repoRoot,
      workspace_root: workspaceRoot,
      task_id: "TASK-1",
      git_provider: provider
    });

    const second = await prepareTaskWorkspace({
      repo_root: repoRoot,
      workspace_root: workspaceRoot,
      task_id: "TASK-1",
      git_provider: provider
    });

    expect(second.created).toBe(true);
    expect(second.branch_name).toBe(first.branch_name);
    expect(second.workspace_path).toBe(first.workspace_path);
    expect(await runGit(["branch", "--show-current"], second.workspace_path)).toBe("feat/task-1");
  });

  it("fails with a typed error when a target branch is already in use by another task workspace", async () => {
    const repoRoot = await createRepository();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "specforge-workspaces-"));
    const provider = createNativeGitProvider();

    await prepareTaskWorkspace({
      repo_root: repoRoot,
      workspace_root: workspaceRoot,
      task_id: "TASK-1",
      branch_name: "feat/shared-branch",
      git_provider: provider
    });

    await expect(
      prepareTaskWorkspace({
        repo_root: repoRoot,
        workspace_root: workspaceRoot,
        task_id: "TASK-2",
        branch_name: "feat/shared-branch",
        git_provider: provider
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<TaskWorkspaceManagerError>>({
        code: "branch_in_use"
      })
    );
  });

  it("force-cleans disposable task worktrees and no-ops after removal", async () => {
    const repoRoot = await createRepository();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "specforge-workspaces-"));
    const provider = createNativeGitProvider();

    const result = await prepareTaskWorkspace({
      repo_root: repoRoot,
      workspace_root: workspaceRoot,
      task_id: "TASK-1",
      git_provider: provider
    });

    await writeFile(join(result.workspace_path, "DIRTY.md"), "dirty\n", "utf8");

    const removed = await cleanupTaskWorkspace({
      repo_root: repoRoot,
      workspace_root: workspaceRoot,
      task_id: "TASK-1",
      git_provider: provider
    });

    expect(removed.removed).toBe(true);

    const worktrees = await provider.listWorktrees({ repo_root: repoRoot });
    const normalizedWorktreePath = await realpath(join(workspaceRoot));
    expect(
      worktrees.some((worktree) => worktree.path.startsWith(normalizedWorktreePath) && worktree.branch_name === "feat/task-1")
    ).toBe(false);

    const secondRemoval = await cleanupTaskWorkspace({
      repo_root: repoRoot,
      workspace_root: workspaceRoot,
      task_id: "TASK-1",
      git_provider: provider
    });

    expect(secondRemoval.removed).toBe(false);

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("fails with a typed error when task_id cannot produce a workspace target", async () => {
    const repoRoot = await createRepository();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "specforge-workspaces-"));
    const provider = createNativeGitProvider();

    await expect(
      prepareTaskWorkspace({
        repo_root: repoRoot,
        workspace_root: workspaceRoot,
        task_id: "___",
        git_provider: provider
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<TaskWorkspaceManagerError>>({
        code: "invalid_task_id"
      })
    );
  });
});
