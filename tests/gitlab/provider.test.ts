import { describe, expect, it } from "vitest";

import {
  GitLabProviderError,
  createGitLabProvider
} from "../../src/core/gitlab/provider.js";

describe("gitlab provider createPullRequest", () => {
  it("creates a merge request behind the common provider contract and preserves linked issues", async () => {
    const calls: string[][] = [];
    const provider = createGitLabProvider({
      exec: async (args) => {
        calls.push(args);

        return {
          stdout: JSON.stringify({
            iid: 42,
            web_url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/42",
            source_branch: "feat/task-1",
            target_branch: "main",
            description: "## Summary\n- complete the task\n\nCloses #40\nCloses #41"
          }),
          stderr: ""
        };
      }
    });

    const result = await provider.createPullRequest({
      repository: "gitlab-org/cli",
      title: "feat: implement task flow",
      body: "## Summary\n- complete the task",
      base_branch: "main",
      head_branch: "feat/task-1",
      linked_issue_numbers: [40, 41],
      draft: true
    });

    expect(result).toEqual({
      number: 42,
      url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/42",
      head_branch: "feat/task-1",
      base_branch: "main",
      linked_issue_numbers: [40, 41]
    });
    expect(calls).toEqual([
      [
        "api",
        "projects/gitlab-org%2Fcli/merge_requests",
        "--method",
        "POST",
        "--field",
        "source_branch=feat/task-1",
        "--field",
        "target_branch=main",
        "--field",
        "title=Draft: feat: implement task flow",
        "--field",
        "description=## Summary\n- complete the task\n\nCloses #40\nCloses #41"
      ]
    ]);
  });

  it("fails with a typed error when repository format is invalid", async () => {
    const provider = createGitLabProvider({
      exec: async () => ({ stdout: "", stderr: "" })
    });

    await expect(
      provider.createPullRequest({
        repository: "bad",
        title: "feat: implement task flow",
        body: "summary",
        base_branch: "main",
        head_branch: "feat/task-1"
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GitLabProviderError>>({
        code: "invalid_repository"
      })
    );
  });
});

describe("gitlab provider getPullRequestStatus", () => {
  it("maps GitLab merge request state into the common status contract", async () => {
    const calls: string[][] = [];
    const provider = createGitLabProvider({
      exec: async (args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify({
            iid: 42,
            web_url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/42",
            title: "feat: implement task flow",
            state: "opened",
            draft: false,
            detailed_merge_status: "mergeable",
            source_branch: "feat/task-1",
            target_branch: "main",
            description: "Implements the task flow.\n\nCloses #40",
            head_pipeline: {
              status: "running",
              web_url: "https://gitlab.com/gitlab-org/cli/-/pipelines/100"
            }
          }),
          stderr: ""
        };
      }
    });

    const result = await provider.getPullRequestStatus({
      pull_request: "https://gitlab.com/gitlab-org/cli/-/merge_requests/42"
    });

    expect(calls).toEqual([["api", "projects/gitlab-org%2Fcli/merge_requests/42"]]);
    expect(result).toEqual({
      provider: "gitlab",
      request_kind: "merge_request",
      number: 42,
      url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/42",
      title: "feat: implement task flow",
      state: "open",
      merge_state_status: "clean",
      head_branch: "feat/task-1",
      base_branch: "main",
      linked_issue_numbers: [40],
      overall_status: "pending",
      status_checks: [
        {
          name: "head_pipeline",
          type: "pipeline",
          status: "in_progress",
          conclusion: "pending",
          details_url: "https://gitlab.com/gitlab-org/cli/-/pipelines/100"
        }
      ]
    });
  });
});
