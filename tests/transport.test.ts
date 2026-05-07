import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import type { JobRecord } from "../src/jobs";
import { runChatGptJob } from "../src/transport";
import { ProError } from "../src/errors";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function withTokenFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pro-token-test-"));
  const path = join(dir, "token.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        source: "pro-cdp-page",
        accessToken: fakeJwt(),
        accountId: "acct_test",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    );
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ChatGPT transport", () => {
  test("posts Codex Responses request and parses streamed text deltas", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let requestBody: Record<string, unknown> = {};
      let authHeader = "";
      let accountHeader = "";
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        authHeader = headers.get("authorization") ?? "";
        accountHeader = headers.get("chatgpt-account-id") ?? "";
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          [
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"O"}',
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"K"}',
            'event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"content":[{"text":"OK"}]}]}}',
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }) as unknown as typeof fetch;

      const result = await runChatGptJob(job(), { sessionTokenPath });

      expect(result).toBe("OK");
      expect(authHeader).toStartWith("Bearer ");
      expect(accountHeader).toBe("acct_test");
      expect(requestBody?.model).toBe("gpt-5.5");
      expect(requestBody?.stream).toBe(true);
      expect(requestBody?.instructions).toBe("Use terse answers.");
      expect(requestBody?.text).toEqual({ verbosity: "high" });
      expect(requestBody?.tool_choice).toBe("none");
      expect(requestBody?.parallel_tool_calls).toBe(false);
      expect(requestBody?.reasoning).toEqual({ effort: "low", summary: "detailed" });
    });
  });

  test("retries transient upstream failures", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let attempts = 0;
      globalThis.fetch = (async () => {
        attempts += 1;
        if (attempts === 1) return new Response("busy", { status: 503 });
        return new Response(
          [
            'event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"content":[{"text":"OK"}]}]}}',
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }) as unknown as typeof fetch;

      const result = await runChatGptJob(job(), {
        sessionTokenPath,
        retries: 1,
        retryDelayMs: 0,
      });

      expect(result).toBe("OK");
      expect(attempts).toBe(2);
    });
  });

  test("maps non-OK upstream responses to structured errors", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      globalThis.fetch = (async () =>
        new Response("<html>limit</html>", {
          status: 429,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch;

      await expect(runChatGptJob(job(), { sessionTokenPath })).rejects.toThrow(ProError);
    });
  });
});

function job(): JobRecord {
  const now = new Date().toISOString();
  return {
    id: "job_test",
    status: "running",
    prompt: "Reply with OK only.",
    model: "auto",
    reasoning: "low",
    options: {
      instructions: "Use terse answers.",
      verbosity: "high",
      reasoningSummary: "detailed",
      toolChoice: "none",
      parallelTools: false,
    },
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

function fakeJwt(): string {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
  };
  return ["header", base64Url(JSON.stringify(payload)), "sig"].join(".");
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
