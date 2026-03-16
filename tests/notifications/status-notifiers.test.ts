import { describe, expect, it } from "vitest";

import {
  StatusNotifierError,
  createWebhookStatusNotifier,
  emitStatusNotification
} from "../../src/core/notifiers/statusNotifiers.js";
import type { GitHubPullRequestStatus } from "../../src/core/github/provider.js";

describe("status notifier adapters", () => {
  it("posts pull request status events to a webhook adapter", async () => {
    const calls: Array<{
      url: string;
      method: string;
      headers: HeadersInit | undefined;
      body: string;
    }> = [];
    const notifier = createWebhookStatusNotifier({
      webhook_url: "https://hooks.example.test/specforge",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          headers: init?.headers,
          body: String(init?.body ?? "")
        });

        return new Response(null, { status: 204 });
      }
    });

    const deliveries = await emitStatusNotification({
      pull_request: buildPullRequestStatus(),
      repository: "iKwesi/SpecForge",
      emitted_at: new Date("2026-03-16T00:00:00.000Z"),
      notifiers: [notifier]
    });

    expect(deliveries).toEqual([
      {
        adapter_id: "webhook",
        delivery_status: "delivered",
        message: "Status event delivered."
      }
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: "https://hooks.example.test/specforge",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-specforge-event-kind": "pull_request_status"
      },
      body: JSON.stringify({
        event_kind: "pull_request_status",
        emitted_at: "2026-03-16T00:00:00.000Z",
        repository: "iKwesi/SpecForge",
        pull_request: buildPullRequestStatus()
      })
    });
  });

  it("isolates notifier delivery failures instead of throwing from the status flow", async () => {
    const deliveries = await emitStatusNotification({
      pull_request: buildPullRequestStatus(),
      notifiers: [
        {
          adapter_id: "unstable-webhook",
          async notify() {
            throw new Error("socket hang up");
          }
        }
      ]
    });

    expect(deliveries).toEqual([
      {
        adapter_id: "unstable-webhook",
        delivery_status: "failed",
        message: "socket hang up"
      }
    ]);
  });

  it("rejects invalid webhook urls with a typed error", () => {
    expect(() =>
      createWebhookStatusNotifier({
        webhook_url: "ftp://hooks.example.test/specforge"
      })
    ).toThrowError(
      expect.objectContaining<Partial<StatusNotifierError>>({
        code: "invalid_notifier"
      })
    );
  });

  it("accepts valid webhook urls even when copy-pasted with surrounding whitespace", async () => {
    const calls: string[] = [];
    const notifier = createWebhookStatusNotifier({
      webhook_url: "  https://hooks.example.test/specforge  ",
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(null, { status: 204 });
      }
    });

    const deliveries = await emitStatusNotification({
      pull_request: buildPullRequestStatus(),
      notifiers: [notifier]
    });

    expect(deliveries).toEqual([
      {
        adapter_id: "webhook",
        delivery_status: "delivered",
        message: "Status event delivered."
      }
    ]);
    expect(calls).toEqual(["https://hooks.example.test/specforge"]);
  });
});

function buildPullRequestStatus(): GitHubPullRequestStatus {
  return {
    number: 123,
    url: "https://github.com/iKwesi/SpecForge/pull/123",
    title: "feat: implement task flow",
    state: "open",
    merge_state_status: "clean",
    head_branch: "feat/task-1",
    base_branch: "main",
    linked_issue_numbers: [40],
    overall_status: "success",
    status_checks: [
      {
        name: "build",
        type: "check_run",
        status: "completed",
        conclusion: "success",
        workflow_name: "ci",
        details_url: "https://example.com/build"
      }
    ]
  };
}
