import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_PROVIDER_NAMES = ["native-git", "gitbutler"] as const;
const NATIVE_GIT_CAPABILITIES = {
  branch: true,
  worktree: true
} as const;

export type GitProviderName = (typeof GIT_PROVIDER_NAMES)[number];
export type GitProviderFallbackReason = "preferred_provider_unavailable";

export interface GitProviderCapabilities {
  branch: boolean;
  worktree: boolean;
}

export interface GitRepositoryInput {
  repo_root: string;
}

export interface GitCreateBranchInput extends GitRepositoryInput {
  branch_name: string;
  start_point?: string;
}

export interface GitCheckoutBranchInput extends GitRepositoryInput {
  branch_name: string;
}

export interface GitAddWorktreeInput extends GitRepositoryInput {
  worktree_path: string;
  branch_name: string;
  start_point?: string;
  create_branch?: boolean;
}

export interface GitRemoveWorktreeInput extends GitRepositoryInput {
  worktree_path: string;
  force?: boolean;
}

export interface GitWorktreeInfo {
  path: string;
  branch_name?: string;
  head: string;
  bare: boolean;
  detached: boolean;
  is_current: boolean;
}

export interface GitProvider {
  readonly name: GitProviderName;
  readonly capabilities: GitProviderCapabilities;
  isAvailable(): Promise<boolean>;
  getCurrentBranch(input: GitRepositoryInput): Promise<string>;
  createBranch(input: GitCreateBranchInput): Promise<void>;
  checkoutBranch(input: GitCheckoutBranchInput): Promise<void>;
  listWorktrees(input: GitRepositoryInput): Promise<GitWorktreeInfo[]>;
  addWorktree(input: GitAddWorktreeInput): Promise<void>;
  removeWorktree(input: GitRemoveWorktreeInput): Promise<void>;
}

export type GitProviderErrorCode =
  | "provider_unavailable"
  | "repository_not_found"
  | "invalid_branch_name"
  | "command_failed";

export class GitProviderError extends Error {
  readonly code: GitProviderErrorCode;
  readonly details?: unknown;

  constructor(code: GitProviderErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "GitProviderError";
    this.code = code;
    this.details = details;
  }
}

export interface ResolveGitProviderInput {
  preferred_provider?: GitProviderName;
  git_binary?: string;
}

export interface GitProviderResolution {
  provider: GitProvider;
  selected_provider: GitProviderName;
  preferred_provider?: GitProviderName;
  fallback_used: boolean;
  fallback_reason?: GitProviderFallbackReason;
}

/**
 * Resolve the provider requested by policy, but fail over to native git when an
 * experimental adapter target is unavailable. This keeps v1 execution grounded in
 * a working path without blocking future provider expansion.
 */
export async function resolveGitProvider(
  input: ResolveGitProviderInput = {}
): Promise<GitProviderResolution> {
  const nativeGitProvider = createNativeGitProvider({
    ...(input.git_binary ? { git_binary: input.git_binary } : {})
  });
  const preferredProvider = input.preferred_provider ?? "native-git";

  if (preferredProvider === "native-git") {
    await ensureProviderAvailable(nativeGitProvider);
    return {
      provider: nativeGitProvider,
      selected_provider: "native-git",
      preferred_provider: preferredProvider,
      fallback_used: false
    };
  }

  const gitButlerProvider = createGitButlerPlaceholderProvider();
  if (await gitButlerProvider.isAvailable()) {
    return {
      provider: gitButlerProvider,
      selected_provider: "gitbutler",
      preferred_provider: preferredProvider,
      fallback_used: false
    };
  }

  await ensureProviderAvailable(nativeGitProvider);
  return {
    provider: nativeGitProvider,
    selected_provider: "native-git",
    preferred_provider: preferredProvider,
    fallback_used: true,
    fallback_reason: "preferred_provider_unavailable"
  };
}

export function createNativeGitProvider(input: { git_binary?: string } = {}): GitProvider {
  return new NativeGitProvider(input.git_binary ?? "git");
}

function createGitButlerPlaceholderProvider(): GitProvider {
  return {
    name: "gitbutler",
    capabilities: { ...NATIVE_GIT_CAPABILITIES },
    async isAvailable() {
      return false;
    },
    async getCurrentBranch() {
      throw new GitProviderError(
        "provider_unavailable",
        "gitbutler provider is not available in this v1 implementation."
      );
    },
    async createBranch() {
      throw new GitProviderError(
        "provider_unavailable",
        "gitbutler provider is not available in this v1 implementation."
      );
    },
    async checkoutBranch() {
      throw new GitProviderError(
        "provider_unavailable",
        "gitbutler provider is not available in this v1 implementation."
      );
    },
    async listWorktrees() {
      throw new GitProviderError(
        "provider_unavailable",
        "gitbutler provider is not available in this v1 implementation."
      );
    },
    async addWorktree() {
      throw new GitProviderError(
        "provider_unavailable",
        "gitbutler provider is not available in this v1 implementation."
      );
    },
    async removeWorktree() {
      throw new GitProviderError(
        "provider_unavailable",
        "gitbutler provider is not available in this v1 implementation."
      );
    }
  };
}

class NativeGitProvider implements GitProvider {
  readonly name = "native-git" as const;
  readonly capabilities: GitProviderCapabilities = { ...NATIVE_GIT_CAPABILITIES };

  constructor(private readonly gitBinary: string) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.gitBinary, ["--version"], { encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentBranch(input: GitRepositoryInput): Promise<string> {
    await ensureRepositoryExists(input.repo_root);

    const output = await this.runGit(["branch", "--show-current"], input.repo_root);
    const branchName = output.trim();
    if (branchName.length === 0) {
      throw new GitProviderError(
        "command_failed",
        `Repository at ${input.repo_root} is not on a named branch.`
      );
    }

    return branchName;
  }

  async createBranch(input: GitCreateBranchInput): Promise<void> {
    await ensureRepositoryExists(input.repo_root);
    await this.ensureValidBranchName(input.branch_name);

    await this.runGit(
      ["branch", input.branch_name, ...(input.start_point ? [input.start_point] : [])],
      input.repo_root
    );
  }

  async checkoutBranch(input: GitCheckoutBranchInput): Promise<void> {
    await ensureRepositoryExists(input.repo_root);
    await this.ensureValidBranchName(input.branch_name);

    await this.runGit(["checkout", input.branch_name], input.repo_root);
  }

  async listWorktrees(input: GitRepositoryInput): Promise<GitWorktreeInfo[]> {
    await ensureRepositoryExists(input.repo_root);
    const output = await this.runGit(["worktree", "list", "--porcelain"], input.repo_root);
    return await parseWorktreeList(output, input.repo_root);
  }

  async addWorktree(input: GitAddWorktreeInput): Promise<void> {
    await ensureRepositoryExists(input.repo_root);
    await this.ensureValidBranchName(input.branch_name);

    const createBranch = input.create_branch === true;
    const args = ["worktree", "add"];

    if (createBranch) {
      args.push("-b", input.branch_name, input.worktree_path, input.start_point ?? "HEAD");
    } else {
      args.push(input.worktree_path, input.branch_name);
    }

    await this.runGit(args, input.repo_root);
  }

  async removeWorktree(input: GitRemoveWorktreeInput): Promise<void> {
    await ensureRepositoryExists(input.repo_root);

    await this.runGit(
      ["worktree", "remove", ...(input.force ? ["--force"] : []), input.worktree_path],
      input.repo_root
    );
  }

  private async ensureValidBranchName(branchName: string): Promise<void> {
    const normalizedBranchName = branchName.trim();
    if (normalizedBranchName.length === 0) {
      throw new GitProviderError("invalid_branch_name", "branch_name must be non-empty.");
    }

    try {
      await execFileAsync(this.gitBinary, ["check-ref-format", "--branch", normalizedBranchName], {
        encoding: "utf8"
      });
    } catch (error) {
      throw new GitProviderError(
        "invalid_branch_name",
        `Invalid branch name: ${branchName}`,
        error
      );
    }
  }

  private async runGit(args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.gitBinary, args, {
        encoding: "utf8",
        ...(cwd ? { cwd } : {})
      });
      return stdout.trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GitProviderError(
          "provider_unavailable",
          `Git binary was not found: ${this.gitBinary}`,
          error
        );
      }

      throw new GitProviderError(
        "command_failed",
        `Git command failed: ${this.gitBinary} ${args.join(" ")}`,
        error
      );
    }
  }
}

async function ensureProviderAvailable(provider: GitProvider): Promise<void> {
  if (await provider.isAvailable()) {
    return;
  }

  throw new GitProviderError(
    "provider_unavailable",
    `Preferred git provider is unavailable: ${provider.name}`
  );
}

async function ensureRepositoryExists(repoRoot: string): Promise<void> {
  try {
    const stats = await lstat(repoRoot);
    if (!stats.isDirectory()) {
      throw new GitProviderError(
        "repository_not_found",
        `Repository root is not a directory: ${repoRoot}`
      );
    }
  } catch (error) {
    if (error instanceof GitProviderError) {
      throw error;
    }

    throw new GitProviderError(
      "repository_not_found",
      `Repository root was not found: ${repoRoot}`,
      error
    );
  }
}

/**
 * Git emits worktree state as porcelain records separated by blank lines. We parse only
 * the fields needed by current callers so later lifecycle code can stay provider-agnostic.
 */
async function parseWorktreeList(output: string, repoRoot: string): Promise<GitWorktreeInfo[]> {
  const records = output
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  const normalizedRepoRoot = await normalizeExistingPath(repoRoot);

  const worktrees: GitWorktreeInfo[] = [];
  for (const record of records) {
    let path = "";
    let branchName: string | undefined;
    let head = "";
    let bare = false;
    let detached = false;

    for (const line of record.split("\n")) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
        continue;
      }

      if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
        continue;
      }

      if (line.startsWith("branch refs/heads/")) {
        branchName = line.slice("branch refs/heads/".length);
        continue;
      }

      if (line === "bare") {
        bare = true;
        continue;
      }

      if (line === "detached") {
        detached = true;
      }
    }

    const normalizedPath = await normalizeExistingPath(path);
    worktrees.push({
      path: normalizedPath,
      ...(branchName ? { branch_name: branchName } : {}),
      head,
      bare,
      detached,
      is_current: normalizedPath === normalizedRepoRoot
    });
  }

  return worktrees;
}

async function normalizeExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
