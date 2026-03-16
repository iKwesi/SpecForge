import {
  createGitHubProvider,
  type GitHubProvider
} from "../github/provider.js";
import {
  createGitLabProvider,
  type GitLabProvider
} from "../gitlab/provider.js";
import type {
  CreatePullRequestInput,
  GetPullRequestStatusInput,
  IssueTrackerProvider,
  IssueTrackerProviderName,
  IssueTrackerPullRequestRef,
  IssueTrackerPullRequestStatus
} from "./contracts.js";

export type {
  CreatePullRequestInput,
  GetPullRequestStatusInput,
  IssueTrackerProvider,
  IssueTrackerProviderName,
  IssueTrackerPullRequestRef,
  IssueTrackerPullRequestStatus
} from "./contracts.js";

export interface CreateIssueTrackerProviderInput {
  provider?: IssueTrackerProviderName;
  pull_request?: string;
  github_provider?: GitHubProvider;
  gitlab_provider?: GitLabProvider;
  gh_binary?: string;
  glab_binary?: string;
}

export function inferIssueTrackerProviderName(
  pullRequestRef: string | undefined
): IssueTrackerProviderName {
  if (!pullRequestRef) {
    return "github";
  }

  try {
    const url = new URL(pullRequestRef);
    if (url.hostname === "gitlab.com" && url.pathname.includes("/-/merge_requests/")) {
      return "gitlab";
    }

    if (url.hostname === "github.com" && url.pathname.includes("/pull/")) {
      return "github";
    }
  } catch {
    return "github";
  }

  return "github";
}

export function createIssueTrackerProvider(
  input: CreateIssueTrackerProviderInput = {}
): IssueTrackerProvider {
  const providerName = input.provider ?? inferIssueTrackerProviderName(input.pull_request);

  if (providerName === "gitlab") {
    return (
      input.gitlab_provider ??
      createGitLabProvider({
        ...(input.glab_binary ? { glab_binary: input.glab_binary } : {})
      })
    );
  }

  return adaptGitHubProvider(
    input.github_provider ??
      createGitHubProvider({
        ...(input.gh_binary ? { gh_binary: input.gh_binary } : {})
      })
  );
}

export function adaptGitHubProvider(provider: GitHubProvider): IssueTrackerProvider {
  return {
    name: "github",
    request_kind: "pull_request",
    async isAvailable() {
      return provider.isAvailable();
    },
    async createPullRequest(input: CreatePullRequestInput): Promise<IssueTrackerPullRequestRef> {
      return provider.createPullRequest(input);
    },
    async getPullRequestStatus(
      input: GetPullRequestStatusInput
    ): Promise<IssueTrackerPullRequestStatus> {
      const result = await provider.getPullRequestStatus(input);

      return {
        provider: "github",
        request_kind: "pull_request",
        ...result
      };
    }
  };
}
