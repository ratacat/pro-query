import { EXIT, ProError } from "./errors";
import type { JobRecord } from "./jobs";
import { isTokenFresh, loadSessionToken } from "./session-token";

export interface TransportOptions {
  sessionTokenPath: string;
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

  const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
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

  return readResponseStream(response);
}

function buildRequestBody(job: JobRecord): Record<string, unknown> {
  const model = job.model === "auto" ? "gpt-5.5" : job.model;
  return {
    model,
    store: false,
    stream: true,
    instructions: "You are a concise assistant responding to a terminal automation request.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: job.prompt }],
      },
    ],
    text: { verbosity: String(job.options.verbosity ?? "medium") },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: {
      effort: normalizeReasoning(job.reasoning),
      summary: "auto",
    },
  };
}

async function readResponseStream(response: Response): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let completedText: string | null = null;

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
        const finalText = readCompletedText(event);
        if (finalText) completedText = finalText;
      }
      boundary = buffer.indexOf("\n\n");
    }
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

function readErrorMessage(event: Record<string, unknown>): string {
  const error = event.error as { message?: unknown } | undefined;
  return typeof error?.message === "string" ? error.message : "ChatGPT backend returned an error event.";
}

function normalizeReasoning(reasoning: string): string {
  if (["low", "medium", "high"].includes(reasoning)) return reasoning;
  return "low";
}
