import { describe, expect, it } from "vitest";

import {
  GitHubProviderError,
  createGitHubProvider
} from "../../src/core/github/provider.js";

describe("github provider createPullRequest", () => {
  it("creates a pull request, appends issue linkage, and returns linked issues", async () => {
    const calls: string[][] = [];
    const provider = createGitHubProvider({
      exec: async (args) => {
        calls.push(args);

        if (args[0] === "pr" && args[1] === "create") {
          return {
            stdout: "https://github.com/iKwesi/SpecForge/pull/123\n",
            stderr: ""
          };
        }

        if (args[0] === "pr" && args[1] === "view") {
          return {
            stdout: JSON.stringify({
              number: 123,
              url: "https://github.com/iKwesi/SpecForge/pull/123",
              headRefName: "feat/task-1",
              baseRefName: "main",
              closingIssuesReferences: [{ number: 40 }, { number: 41 }]
            }),
            stderr: ""
          };
        }

        throw new Error(`Unexpected gh args: ${args.join(" ")}`);
      }
    });

    const result = await provider.createPullRequest({
      repository: "iKwesi/SpecForge",
      title: "feat: implement task flow",
      body: "## Summary\n- complete the task",
      base_branch: "main",
      head_branch: "feat/task-1",
      linked_issue_numbers: [40, 41]
    });

    expect(result.number).toBe(123);
    expect(result.url).toBe("https://github.com/iKwesi/SpecForge/pull/123");
    expect(result.linked_issue_numbers).toEqual([40, 41]);
    expect(calls[0]).toEqual([
      "pr",
      "create",
      "--repo",
      "iKwesi/SpecForge",
      "--base",
      "main",
      "--head",
      "feat/task-1",
      "--title",
      "feat: implement task flow",
      "--body",
      "## Summary\n- complete the task\n\nCloses #40\nCloses #41"
    ]);
    expect(calls[1]).toEqual([
      "pr",
      "view",
      "https://github.com/iKwesi/SpecForge/pull/123",
      "--repo",
      "iKwesi/SpecForge",
      "--json",
      "number,url,headRefName,baseRefName,closingIssuesReferences"
    ]);
  });

  it("fails with a typed error when repository format is invalid", async () => {
    const provider = createGitHubProvider({
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
      expect.objectContaining<Partial<GitHubProviderError>>({
        code: "invalid_repository"
      })
    );
  });
});

describe("github provider getPullRequestStatus", () => {
  it("maps GitHub status checks into a deterministic status report", async () => {
    const provider = createGitHubProvider({
      exec: async (args) => {
        expect(args).toEqual([
          "pr",
          "view",
          "123",
          "--repo",
          "iKwesi/SpecForge",
          "--json",
          "number,url,title,state,mergeStateStatus,headRefName,baseRefName,statusCheckRollup,closingIssuesReferences"
        ]);

        return {
          stdout: JSON.stringify({
            number: 123,
            url: "https://github.com/iKwesi/SpecForge/pull/123",
            title: "feat: implement task flow",
            state: "OPEN",
            mergeStateStatus: "CLEAN",
            headRefName: "feat/task-1",
            baseRefName: "main",
            closingIssuesReferences: [{ number: 40 }],
            statusCheckRollup: [
              {
                __typename: "CheckRun",
                name: "build",
                status: "COMPLETED",
                conclusion: "SUCCESS",
                workflowName: "ci",
                detailsUrl: "https://example.com/build"
              },
              {
                __typename: "CheckRun",
                name: "test",
                status: "IN_PROGRESS",
                conclusion: "",
                workflowName: "ci",
                detailsUrl: "https://example.com/test"
              }
            ]
          }),
          stderr: ""
        };
      }
    });

    const result = await provider.getPullRequestStatus({
      repository: "iKwesi/SpecForge",
      pull_request: "123"
    });

    expect(result.number).toBe(123);
    expect(result.overall_status).toBe("pending");
    expect(result.linked_issue_numbers).toEqual([40]);
    expect(result.status_checks).toEqual([
      {
        name: "build",
        type: "check_run",
        status: "completed",
        conclusion: "success",
        workflow_name: "ci",
        details_url: "https://example.com/build"
      },
      {
        name: "test",
        type: "check_run",
        status: "in_progress",
        conclusion: "pending",
        workflow_name: "ci",
        details_url: "https://example.com/test"
      }
    ]);
  });
});
