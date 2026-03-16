import type { IssueTrackerPullRequestStatus } from "../trackers/provider.js";

export type StatusNotifierErrorCode = "invalid_notifier" | "delivery_failed";

export class StatusNotifierError extends Error {
  readonly code: StatusNotifierErrorCode;
  readonly details?: unknown;

  constructor(code: StatusNotifierErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "StatusNotifierError";
    this.code = code;
    this.details = details;
  }
}

export interface PullRequestStatusNotificationEvent {
  event_kind: "pull_request_status";
  emitted_at: string;
  repository?: string;
  pull_request: IssueTrackerPullRequestStatus;
}

export type StatusNotificationEvent = PullRequestStatusNotificationEvent;

export interface StatusNotifier {
  adapter_id: string;
  notify(event: StatusNotificationEvent): Promise<void>;
}

export interface StatusNotificationDelivery {
  adapter_id: string;
  delivery_status: "delivered" | "failed";
  message: string;
}

export interface EmitStatusNotificationInput {
  pull_request: IssueTrackerPullRequestStatus;
  repository?: string;
  emitted_at?: Date;
  notifiers: StatusNotifier[];
}

type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ ok: boolean; status: number }>;

export function createWebhookStatusNotifier(input: {
  webhook_url: string;
  adapter_id?: string;
  fetch?: FetchLike;
}): StatusNotifier {
  const webhookUrl = normalizeWebhookUrl(input.webhook_url);
  const adapterId = normalizeAdapterId(input.adapter_id ?? "webhook");
  const fetchImpl = input.fetch ?? resolveGlobalFetch();

  return {
    adapter_id: adapterId,
    async notify(event) {
      try {
        const response = await fetchImpl(webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-specforge-event-kind": event.event_kind
          },
          body: JSON.stringify(event)
        });

        if (!response.ok) {
          throw new StatusNotifierError(
            "delivery_failed",
            `Webhook delivery failed with HTTP ${response.status}.`
          );
        }
      } catch (error) {
        if (error instanceof StatusNotifierError) {
          throw error;
        }

        throw new StatusNotifierError(
          "delivery_failed",
          error instanceof Error ? error.message : String(error),
          error
        );
      }
    }
  };
}

export async function emitStatusNotification(
  input: EmitStatusNotificationInput
): Promise<StatusNotificationDelivery[]> {
  const event: StatusNotificationEvent = {
    event_kind: "pull_request_status",
    emitted_at: (input.emitted_at ?? new Date()).toISOString(),
    ...(input.repository ? { repository: input.repository } : {}),
    pull_request: input.pull_request
  };

  return Promise.all(
    input.notifiers.map(async (notifier) => {
      try {
        await notifier.notify(event);
        return {
          adapter_id: notifier.adapter_id,
          delivery_status: "delivered",
          message: "Status event delivered."
        };
      } catch (error) {
        return {
          adapter_id: notifier.adapter_id,
          delivery_status: "failed",
          message: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );
}

function normalizeWebhookUrl(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StatusNotifierError(
      "invalid_notifier",
      "webhook_url must be a non-empty http(s) URL."
    );
  }
  const trimmed = value.trim();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new StatusNotifierError(
      "invalid_notifier",
      "webhook_url must be a valid http(s) URL.",
      error
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StatusNotifierError(
      "invalid_notifier",
      "webhook_url must use http or https."
    );
  }

  return url.toString();
}

function normalizeAdapterId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StatusNotifierError(
      "invalid_notifier",
      "adapter_id must be a non-empty string.",
      { adapter_id: value }
    );
  }

  return value.trim();
}

function resolveGlobalFetch(): FetchLike {
  if (typeof globalThis.fetch !== "function") {
    throw new StatusNotifierError(
      "invalid_notifier",
      "Global fetch is unavailable; provide a fetch implementation explicitly."
    );
  }

  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    return {
      ok: response.ok,
      status: response.status
    };
  };
}
