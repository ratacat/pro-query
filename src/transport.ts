import { EXIT, ProError } from "./errors";
import type { JobRecord } from "./jobs";
import { isTokenFresh, loadSessionToken } from "./session-token";

export interface TransportOptions {
  sessionTokenPath: string;
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
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(new Error("ChatGPT request timed out.")), timeoutMs)
    : null;

  try {
    const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      signal: controller?.signal,
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "chatgpt-account-id": session.accountId,
        "openai-beta": "responses=experimental",
        originator: "pro-cli",
        accept: "text/event-stream",
        "content-type": "application/json",
        origin: "https://chatgpt.com",
        referer: "https://chatgpt.com/",
        "user-agent": "pro-cli/0.1",
      },
      body: JSON.stringify(buildRequestBody(job)),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new ProError("UPSTREAM_REJECTED", `ChatGPT backend returned HTTP ${response.status}.`, {
        exitCode: EXIT.upstream,
        suggestions: ["Run pro auth capture again.", "Check whether the ChatGPT Pro usage limit is reached."],
        details: { status: response.status, preview: text.slice(0, 160).replace(/\s+/g, " ") },
      });
    }

    return await readResponseStream(response);
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new ProError("REQUEST_TIMEOUT", `ChatGPT request exceeded ${timeoutMs}ms.`, {
        exitCode: EXIT.timeout,
        suggestions: ["Increase --timeout or retry with a smaller prompt."],
        cause: error,
      });
    }
    if (error instanceof ProError) throw error;
    throw networkError(error);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildRequestBody(job: JobRecord): Record<string, unknown> {
  const model = job.model === "auto" ? "gpt-5.5" : job.model;
  const body: Record<string, unknown> = {
    model,
    store: booleanOption(job.options.store, false),
    stream: true,
    instructions:
      stringOption(job.options.instructions) ??
      "You are a concise assistant responding to a terminal automation request.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: job.prompt }],
      },
    ],
    text: { verbosity: normalizeVerbosity(stringOption(job.options.verbosity) ?? "medium") },
    include: ["reasoning.encrypted_content"],
    tool_choice: normalizeToolChoice(stringOption(job.options.toolChoice) ?? "auto"),
    parallel_tool_calls: booleanOption(job.options.parallelTools, true),
    reasoning: {
      effort: normalizeReasoning(job.reasoning),
      summary: normalizeReasoningSummary(stringOption(job.options.reasoningSummary) ?? "auto"),
    },
  };

  return body;
}

async function readResponseStream(response: Response): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let completedText: string | null = null;
  let completed = false;

  for await (const chunk of response.body as ReadableStream<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseFrame(frame);
      if (event) {
        if (event.type === "error") {
          throw new ProError("UPSTREAM_ERROR", readErrorMessage(event), {
            exitCode: EXIT.upstream,
            suggestions: ["Retry later or check usage limits."],
          });
        }
        const delta = readDelta(event);
        if (delta) output += delta;
        const doneText = readOutputTextDone(event);
        if (doneText !== null) completedText = doneText;
        if (event.type === "response.completed") {
          completed = true;
          const finalText = readCompletedText(event);
          if (finalText !== null) completedText = finalText;
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  if (!completed) {
    throw new ProError("STREAM_INCOMPLETE", "ChatGPT stream ended before response.completed.", {
      exitCode: EXIT.network,
      suggestions: ["Retry the job.", "Increase --timeout if the request is large."],
      details: output ? { partialPreview: output.slice(0, 160) } : undefined,
    });
  }

  return completedText ?? output;
}

function parseSseFrame(frame: string): Record<string, unknown> | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  return JSON.parse(data) as Record<string, unknown>;
}

function readDelta(event: Record<string, unknown>): string {
  if (typeof event.delta === "string") return event.delta;
  if (typeof event.text === "string" && String(event.type).includes("delta")) return event.text;
  return "";
}

function readCompletedText(event: Record<string, unknown>): string | null {
  if (event.type !== "response.completed") return null;
  const response = event.response as { output?: unknown[] } | undefined;
  const parts: string[] = [];
  for (const item of response?.output ?? []) {
    const content = (item as { content?: unknown[] }).content ?? [];
    for (const part of content) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function readOutputTextDone(event: Record<string, unknown>): string | null {
  if (event.type !== "response.output_text.done") return null;
  return typeof event.text === "string" ? event.text : null;
}

function readErrorMessage(event: Record<string, unknown>): string {
  const error = event.error as { message?: unknown } | undefined;
  return typeof error?.message === "string" ? error.message : "ChatGPT backend returned an error event.";
}

function normalizeReasoning(reasoning: string): string {
  if (["low", "medium", "high"].includes(reasoning)) return reasoning;
  return "low";
}

function normalizeVerbosity(verbosity: string): string {
  if (["low", "medium", "high"].includes(verbosity)) return verbosity;
  return "medium";
}

function normalizeReasoningSummary(summary: string): string {
  if (["auto", "concise", "detailed", "none"].includes(summary)) return summary;
  return "auto";
}

function normalizeToolChoice(toolChoice: string): string {
  if (["auto", "none", "required"].includes(toolChoice)) return toolChoice;
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
