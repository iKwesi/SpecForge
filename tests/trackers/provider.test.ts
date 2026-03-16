import { describe, expect, it } from "vitest";

import {
  createIssueTrackerProvider,
  inferIssueTrackerProviderName,
  type IssueTrackerProvider
} from "../../src/core/trackers/provider.js";

describe("issue tracker provider resolution", () => {
  it("defaults to github for non-URL pull request references", () => {
    expect(inferIssueTrackerProviderName("123")).toBe("github");
  });

  it("infers gitlab from merge request URLs", () => {
    expect(
      inferIssueTrackerProviderName("https://gitlab.com/gitlab-org/cli/-/merge_requests/42")
    ).toBe("gitlab");
  });

  it("returns the injected gitlab provider when explicitly requested", () => {
    const gitlabProvider: IssueTrackerProvider = {
      name: "gitlab",
      request_kind: "merge_request",
      async isAvailable() {
        return true;
      },
      async createPullRequest() {
        throw new Error("not used");
      },
      async getPullRequestStatus() {
        throw new Error("not used");
      }
    };

    const resolved = createIssueTrackerProvider({
      provider: "gitlab",
      gitlab_provider: gitlabProvider
    });

    expect(resolved).toBe(gitlabProvider);
  });
});
