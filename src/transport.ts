import { randomUUID } from "node:crypto";
import { evaluateInCdpPage } from "./cdp";
import { EXIT, ProError } from "./errors";
import type { JobRecord } from "./jobs";
import { isTokenFresh, loadSessionToken } from "./session-token";

const CHATGPT_CONVERSATION_ENDPOINT = "https://chatgpt.com/backend-api/conversation";
const DEFAULT_CDP_BASE = "http://127.0.0.1:9222";

type PageEvaluator = <T>(cdpBase: string, expression: string, timeoutMs?: number) => Promise<T>;

export interface TransportOptions {
  sessionTokenPath: string;
  cdpBase?: string;
  pageEvaluator?: PageEvaluator;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export async function runChatGptJob(job: JobRecord, options: TransportOptions): Promise<string> {
  const session = await loadSessionToken(options.sessionTokenPath).catch(() => null);
  if (!session) {
    throw new ProError("SESSION_TOKEN_MISSING", "No ChatGPT session token is available.", {
      exitCode: EXIT.auth,
      suggestions: ["Run pro auth capture from a logged-in ChatGPT CDP browser."],
    });
  }
  if (!isTokenFresh(session)) {
    throw new ProError("SESSION_TOKEN_EXPIRED", "The ChatGPT session token is expired.", {
      exitCode: EXIT.auth,
      suggestions: ["Run pro auth capture again from a logged-in ChatGPT browser."],
    });
  }
  if (!session.accountId) {
    throw new ProError("ACCOUNT_ID_MISSING", "The ChatGPT account id is missing from the token.", {
      exitCode: EXIT.auth,
      suggestions: ["Run pro auth capture again and confirm ChatGPT is logged in."],
    });
  }

  const retries = integerOption(options.retries, 0, 0, 5) ?? 0;
  const retryDelayMs = integerOption(options.retryDelayMs, 500, 0, 60_000) ?? 500;
  let lastError: ProError | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await postChatGptJob(job, { accessToken: session.accessToken, accountId: session.accountId }, options);
    } catch (error) {
      const proError = error instanceof ProError ? error : networkError(error);
      lastError = proError;
      if (attempt >= retries || !isRetryable(proError)) throw withAttemptDetails(proError, attempt + 1);
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }

  throw lastError ?? new ProError("UPSTREAM_ERROR", "ChatGPT backend request failed.", { exitCode: EXIT.upstream });
}

async function postChatGptJob(
  job: JobRecord,
  session: { accessToken: string; accountId: string },
  options: TransportOptions,
): Promise<string> {
  const timeoutMs = integerOption(options.timeoutMs ?? job.options.timeoutMs, 0, 0, 30 * 60_000) ?? 0;

  try {
    const evaluate = options.pageEvaluator ?? evaluateInCdpPage;
    const browserResult = await evaluate<BrowserFetchResult>(
      options.cdpBase ?? DEFAULT_CDP_BASE,
      buildBrowserFetchExpression(buildRequestBody(job), session.accessToken, session.accountId),
      timeoutMs || 30 * 60_000,
    );

    if (browserResult.code === "CHATGPT_PAGE_MISSING") {
      throw new ProError("CHATGPT_PAGE_MISSING", "No logged-in ChatGPT page is available over CDP.", {
        exitCode: EXIT.auth,
        suggestions: [
          "Open the Chrome command from pro auth command.",
          "Confirm the CDP Chrome window is on https://chatgpt.com/ and logged in.",
          "Pass --cdp if Chrome is using a non-default CDP port.",
        ],
        details: { cdpBase: options.cdpBase ?? DEFAULT_CDP_BASE },
      });
    }

    if (!browserResult.ok) {
      throw new ProError("UPSTREAM_REJECTED", `ChatGPT backend returned HTTP ${browserResult.status}.`, {
        exitCode: EXIT.upstream,
        suggestions: ["Run pro auth capture again.", "Check whether the ChatGPT Pro usage limit is reached."],
        details: {
          status: browserResult.status,
          preview: browserResult.body.slice(0, 160).replace(/\s+/g, " "),
        },
      });
    }

    return readResponseText(browserResult.body);
  } catch (error) {
    if (error instanceof ProError) throw error;
    throw networkError(error);
  }
}

interface BrowserFetchResult {
  ok: boolean;
  status: number;
  body: string;
  code?: "CHATGPT_PAGE_MISSING";
}

function buildBrowserFetchExpression(
  requestBody: Record<string, unknown>,
  accessToken: string,
  accountId: string,
): string {
  return `(${async function browserFetch(
    endpoint: string,
    body: Record<string, unknown>,
    token: string,
    account: string,
  ): Promise<BrowserFetchResult> {
    if (location.origin !== "https://chatgpt.com") {
      return {
        ok: false,
        status: 0,
        code: "CHATGPT_PAGE_MISSING",
        body: `Expected https://chatgpt.com, got ${location.href}`,
      };
    }

    const headers: Record<string, string> = {
      accept: "text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "oai-language": navigator.language || "en-US",
      originator: "pro-cli",
    };
    if (account) headers["chatgpt-account-id"] = account;

    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text().catch((error) => String(error));
    return { ok: response.ok, status: response.status, body: text };
  }})(${JSON.stringify(CHATGPT_CONVERSATION_ENDPOINT)}, ${JSON.stringify(requestBody)}, ${JSON.stringify(accessToken)}, ${JSON.stringify(accountId)})`;
}

function buildRequestBody(job: JobRecord): Record<string, unknown> {
  const model = stringOption(job.model) ?? "auto";
  const prompt = buildConversationPrompt(job);
  const reasoningEffort = normalizeReasoning(job.reasoning);
  const body: Record<string, unknown> = {
    action: "next",
    messages: [
      {
        id: randomUUID(),
        author: { role: "user" },
        content: { content_type: "text", parts: [prompt] },
        metadata: {},
      },
    ],
    model,
    parent_message_id: randomUUID(),
    timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    suggestions: [],
    history_and_training_disabled: !booleanOption(job.options.store, false),
    conversation_mode: { kind: "primary_assistant" },
    force_paragen: false,
    force_paragen_model_slug: "",
    force_rate_limit: false,
    reset_rate_limits: false,
    websocket_request_id: randomUUID(),
    supports_buffering: true,
    supported_encodings: ["v1"],
  };

  if (reasoningEffort !== "auto") {
    body.reasoning_effort = reasoningEffort;
  }

  return body;
}

function buildConversationPrompt(job: JobRecord): string {
  const instructions =
    stringOption(job.options.instructions) ??
    "You are a concise assistant responding to a terminal automation request.";
  const prompt = job.prompt.trim();
  if (!instructions.trim()) return prompt;
  return `${instructions.trim()}\n\n${prompt}`;
}

function readResponseText(raw: string): string {
  let buffer = raw;
  let completedText: string | null = null;
  let completed = false;

  let boundary = buffer.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const event = parseSseFrame(frame);
    const parsed = readConversationEvent(event);
    completedText = parsed.text ?? completedText;
    completed = completed || parsed.completed;
    boundary = buffer.indexOf("\n\n");
  }

  if (buffer.trim()) {
    const event = parseSseFrame(buffer);
    const parsed = readConversationEvent(event);
    completedText = parsed.text ?? completedText;
    completed = completed || parsed.completed;
  }

  if (!completed) {
    throw new ProError("STREAM_INCOMPLETE", "ChatGPT stream ended before the conversation completed.", {
      exitCode: EXIT.network,
      suggestions: ["Retry the job.", "Increase --timeout if the request is large."],
      details: completedText ? { partialPreview: completedText.slice(0, 160) } : undefined,
    });
  }

  if (completedText === null) {
    throw new ProError("EMPTY_RESPONSE", "ChatGPT completed without returning assistant text.", {
      exitCode: EXIT.upstream,
      suggestions: ["Retry the job.", "Check the job in ChatGPT if this persists."],
    });
  }

  return completedText;
}

function readConversationEvent(event: Record<string, unknown> | null): {
  text: string | null;
  completed: boolean;
} {
  if (!event) return { text: null, completed: false };
  if (event.type === "error") {
    throw new ProError("UPSTREAM_ERROR", readErrorMessage(event), {
      exitCode: EXIT.upstream,
      suggestions: ["Retry later or check usage limits."],
    });
  }
  const messageText = readConversationMessageText(event);
  return {
    text: messageText,
    completed: event.type === "done" || isConversationMessageDone(event),
  };
}

function parseSseFrame(frame: string): Record<string, unknown> | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data) return null;
  if (data === "[DONE]") return { type: "done" };
  return JSON.parse(data) as Record<string, unknown>;
}

function readConversationMessageText(event: Record<string, unknown>): string | null {
  const message = event.message as { author?: unknown; content?: unknown } | undefined;
  const author = message?.author as { role?: unknown } | undefined;
  if (author?.role !== "assistant") return null;

  const content = message?.content as { parts?: unknown } | undefined;
  if (!Array.isArray(content?.parts)) return null;

  const parts = content.parts.filter((part): part is string => typeof part === "string");
  if (parts.length === 0) return null;
  return parts.join("");
}

function isConversationMessageDone(event: Record<string, unknown>): boolean {
  const message = event.message as { status?: unknown; end_turn?: unknown } | undefined;
  return message?.status === "finished_successfully" || message?.end_turn === true;
}

function readErrorMessage(event: Record<string, unknown>): string {
  if (typeof event.error === "string") return event.error;
  const error = event.error as { message?: unknown } | undefined;
  return typeof error?.message === "string" ? error.message : "ChatGPT backend returned an error event.";
}

function normalizeReasoning(reasoning: string): string {
  if (["auto", "low", "medium", "high"].includes(reasoning)) return reasoning;
  return "auto";
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerOption(
  value: unknown,
  fallback: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function booleanOption(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return fallback;
}

function networkError(error: unknown): ProError {
  return new ProError("NETWORK_ERROR", "ChatGPT backend request failed before a response.", {
    exitCode: EXIT.network,
    suggestions: ["Check connectivity and retry.", "Run pro auth status --json if this persists."],
    cause: error,
  });
}

function isRetryable(error: ProError): boolean {
  if (["NETWORK_ERROR", "REQUEST_TIMEOUT", "STREAM_INCOMPLETE"].includes(error.code)) return true;
  const status = error.details?.status;
  return typeof status === "number" && (status === 408 || status === 429 || status >= 500);
}

function withAttemptDetails(error: ProError, attempts: number): ProError {
  return new ProError(error.code, error.message, {
    exitCode: error.exitCode,
    suggestions: error.suggestions,
    details: { ...(error.details ?? {}), attempts },
    cause: error,
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
