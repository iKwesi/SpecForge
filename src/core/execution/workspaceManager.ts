import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { createDryRunReport, type DryRunReport } from "../contracts/dryRun.js";
import {
  GitProviderError,
  resolveGitProvider,
  type GitProvider,
  type GitProviderName,
  type GitProviderResolution,
  type GitWorktreeInfo
} from "../git/provider.js";

const DEFAULT_BRANCH_PREFIX = "feat";

export type TaskWorkspaceManagerErrorCode =
  | "invalid_task_id"
  | "invalid_workspace_root"
  | "workspace_conflict"
  | "branch_in_use";

export class TaskWorkspaceManagerError extends Error {
  readonly code: TaskWorkspaceManagerErrorCode;
  readonly details?: unknown;

  constructor(code: TaskWorkspaceManagerErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "TaskWorkspaceManagerError";
    this.code = code;
    this.details = details;
  }
}

export interface TaskWorkspaceTargetInput {
  workspace_root: string;
  task_id: string;
  branch_name?: string;
  branch_prefix?: string;
}

export interface TaskWorkspaceManagerInput extends TaskWorkspaceTargetInput {
  repo_root: string;
  start_point?: string;
  preferred_provider?: GitProviderName;
  git_binary?: string;
  git_provider?: GitProvider;
  dry_run?: boolean;
}

export interface PrepareTaskWorkspaceResult {
  task_id: string;
  branch_name: string;
  workspace_path: string;
  created: boolean;
  selected_provider: GitProviderName;
  fallback_used: boolean;
  dry_run?: DryRunReport;
}

export interface CleanupTaskWorkspaceResult {
  task_id: string;
  branch_name: string;
  workspace_path: string;
  removed: boolean;
  selected_provider: GitProviderName;
  fallback_used: boolean;
  dry_run?: DryRunReport;
}

/**
 * Prepare an isolated disposable git worktree for one execution task.
 *
 * The mapping from task_id to branch/path is deterministic so retries and cleanup can
 * reason about the same workspace without hidden state. If a matching worktree already
 * exists, we reuse it instead of creating duplicate checkouts for the same task branch.
 */
export async function prepareTaskWorkspace(
  input: TaskWorkspaceManagerInput
): Promise<PrepareTaskWorkspaceResult> {
  const target = resolveTaskWorkspaceTarget(input);
  const providerResolution = await resolveWorkspaceProvider(input);
  const provider = providerResolution.provider;

  if (input.dry_run) {
    return {
      task_id: target.task_id,
      branch_name: target.branch_name,
      workspace_path: target.workspace_path,
      created: false,
      selected_provider: providerResolution.selected_provider,
      fallback_used: providerResolution.fallback_used,
      dry_run: createDryRunReport([
        {
          status: "planned",
          kind: "branch_create",
          target: target.branch_name,
          detail: "Would create or reuse the task branch for isolated execution."
        },
        {
          status: "planned",
          kind: "workspace_prepare",
          target: target.workspace_path,
          detail: "Would prepare an isolated task worktree without mutating the current checkout."
        }
      ])
    };
  }

  await mkdir(target.workspace_root, { recursive: true });

  const worktrees = await provider.listWorktrees({ repo_root: input.repo_root });
  const normalizedWorkspacePath = await normalizePathIfExists(target.workspace_path);
  const existingWorkspace = findWorktreeByPath(worktrees, normalizedWorkspacePath);
  if (existingWorkspace) {
    if (existingWorkspace.branch_name !== target.branch_name) {
      throw new TaskWorkspaceManagerError(
        "workspace_conflict",
        `Workspace path ${target.workspace_path} is already attached to branch ${existingWorkspace.branch_name ?? "detached"}.`
      );
    }

    return {
      task_id: target.task_id,
      branch_name: target.branch_name,
      workspace_path: target.workspace_path,
      created: false,
      selected_provider: providerResolution.selected_provider,
      fallback_used: providerResolution.fallback_used
    };
  }

  if (await pathExists(target.workspace_path)) {
    throw new TaskWorkspaceManagerError(
      "workspace_conflict",
      `Workspace path already exists outside git worktree management: ${target.workspace_path}`
    );
  }

  const branchOwner = findWorktreeByBranch(worktrees, target.branch_name);
  if (branchOwner) {
    throw new TaskWorkspaceManagerError(
      "branch_in_use",
      `Branch ${target.branch_name} is already checked out in worktree ${branchOwner.path}.`
    );
  }

  try {
    await provider.addWorktree({
      repo_root: input.repo_root,
      worktree_path: target.workspace_path,
      branch_name: target.branch_name,
      start_point: input.start_point ?? "HEAD",
      create_branch: true
    });
  } catch (error) {
    if (!shouldRetryWithExistingBranch(error)) {
      throw error;
    }

    // Cleanup removes disposable worktrees but intentionally leaves the task branch behind.
    // A rerun should reattach that branch instead of failing closed on "already exists".
    await provider.addWorktree({
      repo_root: input.repo_root,
      worktree_path: target.workspace_path,
      branch_name: target.branch_name,
      create_branch: false
    });
  }

  return {
    task_id: target.task_id,
    branch_name: target.branch_name,
    workspace_path: target.workspace_path,
    created: true,
    selected_provider: providerResolution.selected_provider,
    fallback_used: providerResolution.fallback_used
  };
}

/**
 * Remove a disposable task worktree. Cleanup defaults to force mode because these
 * workspaces are execution scratch space rather than user-owned feature branches.
 */
export async function cleanupTaskWorkspace(
  input: TaskWorkspaceManagerInput & { force?: boolean }
): Promise<CleanupTaskWorkspaceResult> {
  const target = resolveTaskWorkspaceTarget(input);
  const providerResolution = await resolveWorkspaceProvider(input);
  const provider = providerResolution.provider;

  if (input.dry_run) {
    return {
      task_id: target.task_id,
      branch_name: target.branch_name,
      workspace_path: target.workspace_path,
      removed: false,
      selected_provider: providerResolution.selected_provider,
      fallback_used: providerResolution.fallback_used,
      dry_run: createDryRunReport([
        {
          status: "planned",
          kind: "workspace_remove",
          target: target.workspace_path,
          detail: "Would remove the isolated task worktree without mutating the active checkout."
        }
      ])
    };
  }

  const worktrees = await provider.listWorktrees({ repo_root: input.repo_root });
  const normalizedWorkspacePath = await normalizePathIfExists(target.workspace_path);
  const existingWorkspace = findWorktreeByPath(worktrees, normalizedWorkspacePath);

  if (!existingWorkspace) {
    if (await pathExists(target.workspace_path)) {
      throw new TaskWorkspaceManagerError(
        "workspace_conflict",
        `Workspace path exists outside git worktree management: ${target.workspace_path}`
      );
    }

    return {
      task_id: target.task_id,
      branch_name: target.branch_name,
      workspace_path: target.workspace_path,
      removed: false,
      selected_provider: providerResolution.selected_provider,
      fallback_used: providerResolution.fallback_used
    };
  }

  if (existingWorkspace.branch_name !== target.branch_name) {
    throw new TaskWorkspaceManagerError(
      "workspace_conflict",
      `Workspace path ${target.workspace_path} is attached to branch ${existingWorkspace.branch_name ?? "detached"}, not ${target.branch_name}.`
    );
  }

  await provider.removeWorktree({
    repo_root: input.repo_root,
    worktree_path: target.workspace_path,
    force: input.force ?? true
  });

  return {
    task_id: target.task_id,
    branch_name: target.branch_name,
    workspace_path: target.workspace_path,
    removed: true,
    selected_provider: providerResolution.selected_provider,
    fallback_used: providerResolution.fallback_used
  };
}

export interface ResolvedTaskWorkspaceTarget {
  task_id: string;
  branch_name: string;
  workspace_root: string;
  workspace_path: string;
  workspace_slug: string;
}

export function resolveTaskWorkspaceTarget(
  input: TaskWorkspaceTargetInput
): ResolvedTaskWorkspaceTarget {
  const taskId = input.task_id.trim();
  if (taskId.length === 0) {
    throw new TaskWorkspaceManagerError("invalid_task_id", "task_id must be non-empty.");
  }

  const workspaceRoot = input.workspace_root.trim();
  if (workspaceRoot.length === 0) {
    throw new TaskWorkspaceManagerError(
      "invalid_workspace_root",
      "workspace_root must be non-empty."
    );
  }

  const workspaceSlug = normalizeTaskWorkspaceSlug(taskId);
  if (workspaceSlug.length === 0) {
    throw new TaskWorkspaceManagerError(
      "invalid_task_id",
      `task_id ${taskId} does not produce a valid workspace target.`
    );
  }

  const branchPrefix = (input.branch_prefix ?? DEFAULT_BRANCH_PREFIX).trim();
  const branchName = input.branch_name?.trim() || `${branchPrefix}/${workspaceSlug}`;

  return {
    task_id: taskId,
    branch_name: branchName,
    workspace_root: workspaceRoot,
    workspace_path: join(workspaceRoot, workspaceSlug),
    workspace_slug: workspaceSlug
  };
}

async function resolveWorkspaceProvider(
  input: TaskWorkspaceManagerInput
): Promise<GitProviderResolution> {
  if (input.git_provider) {
    return {
      provider: input.git_provider,
      selected_provider: input.git_provider.name,
      preferred_provider: input.git_provider.name,
      fallback_used: false
    };
  }

  return await resolveGitProvider({
    ...(input.preferred_provider ? { preferred_provider: input.preferred_provider } : {}),
    ...(input.git_binary ? { git_binary: input.git_binary } : {})
  });
}

function findWorktreeByPath(worktrees: GitWorktreeInfo[], workspacePath: string): GitWorktreeInfo | undefined {
  return worktrees.find((worktree) => worktree.path === workspacePath);
}

function findWorktreeByBranch(
  worktrees: GitWorktreeInfo[],
  branchName: string
): GitWorktreeInfo | undefined {
  return worktrees.find((worktree) => worktree.branch_name === branchName);
}

function normalizeTaskWorkspaceSlug(taskId: string): string {
  return taskId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function normalizePathIfExists(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function shouldRetryWithExistingBranch(error: unknown): boolean {
  if (!(error instanceof GitProviderError) || error.code !== "command_failed") {
    return false;
  }

  const originalError = error.details as { stderr?: unknown; message?: unknown } | undefined;
  const stderr = typeof originalError?.stderr === "string" ? originalError.stderr : "";
  const message = typeof originalError?.message === "string" ? originalError.message : "";
  return stderr.includes("already exists") || message.includes("already exists");
}
