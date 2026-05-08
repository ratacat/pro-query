import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { JobRecord } from "../src/jobs";
import { runChatGptJob } from "../src/transport";
import { ProError } from "../src/errors";

async function withTokenFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pro-token-test-"));
  const path = join(dir, "token.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        source: "pro-cli-cdp-page",
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
  test("evaluates ChatGPT frontend conversation request inside the browser page", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let cdpBase = "";
      let expression = "";
      const pageEvaluator = (async <T>(base: string, script: string): Promise<T> => {
        cdpBase = base;
        expression = script;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      const result = await runChatGptJob(job(), {
        sessionTokenPath,
        cdpBase: "http://127.0.0.1:9225",
        pageEvaluator,
      });

      expect(result).toBe("OK");
      expect(cdpBase).toBe("http://127.0.0.1:9225");
      expect(expression).toContain("https://chatgpt.com/backend-api/f/conversation");
      expect(expression).toContain("https://chatgpt.com/backend-api/f/conversation/prepare");
      expect(expression).toContain("https://chatgpt.com/backend-api/f/conversation/resume");
      expect(expression).toContain("https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare");
      expect(expression).toContain("OpenAI-Sentinel-Chat-Requirements-Token");
      expect(expression).not.toContain("codex/responses");
      expect(expression).toContain('"action":"next"');
      expect(expression).toContain('"model":"gpt-5-5-thinking"');
      expect(expression).toContain('"thinking_effort":"min"');
      expect(expression).toContain('"history_and_training_disabled":true');
      expect(expression).toContain("Use terse answers.\\n\\nReply with OK only.");
      expect(expression).not.toContain("header.");
    });
  });

  test("retries transient upstream failures", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let attempts = 0;
      const pageEvaluator = (async <T>(): Promise<T> => {
        attempts += 1;
        if (attempts === 1) return { ok: false, status: 503, body: "busy" } as T;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      const result = await runChatGptJob(job(), {
        sessionTokenPath,
        pageEvaluator,
        retries: 1,
        retryDelayMs: 0,
      });

      expect(result).toBe("OK");
      expect(attempts).toBe(2);
    });
  });

  test("retries incomplete response streams", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let attempts = 0;
      const pageEvaluator = (async <T>(): Promise<T> => {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: true,
            status: 200,
            body: 'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["partial"]},"status":"in_progress"}}\n\n',
          } as T;
        }
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      const result = await runChatGptJob(job(), {
        sessionTokenPath,
        pageEvaluator,
        retries: 1,
        retryDelayMs: 0,
      });

      expect(result).toBe("OK");
      expect(attempts).toBe(2);
    });
  });

  test("accepts streams that only mark completion with DONE", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["OK"]},"status":"in_progress"}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("reads patch-style /f/conversation streams", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"}}}',
            'data: {"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"O"},{"p":"/message/content/parts/0","o":"append","v":"K"}]}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("reads resumed handoff streams appended after the initial response", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"type":"resume_conversation_token","token":"resume_token","conversation_id":"conv_test"}',
            'data: {"type":"stream_handoff","conversation_id":"conv_test"}',
            "data: [DONE]",
            "",
            'data: {"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"O"},{"p":"/message/content/parts/0","o":"append","v":"K"}]}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("keeps accumulated patch text when final snapshots contain only a suffix", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"}}}',
            'data: {"p":"/message/content/parts/0","o":"append","v":"Open Chrome. "}',
            'data: {"v":"Run jobs. "}',
            'data: {"v":"Close it when done."}',
            'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["Close it when done."]},"status":"finished_successfully"}}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("Open Chrome. Run jobs. Close it when done.");
    });
  });

  test("deduplicates repeated continuation frames after path append events", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"}}}',
            'data: {"p":"/message/content/parts/0","o":"append","v":"OK"}',
            'data: {"v":"OK"}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("deduplicates repeated append snapshots after unrelated stream events", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"}}}',
            'data: {"p":"/message/content/parts/0","o":"append","v":"OK"}',
            'data: {"type":"metadata","v":{"ignored":true}}',
            'data: {"v":"OK"}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("maps non-OK upstream responses to structured errors", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({ ok: false, status: 429, body: "<html>limit</html>" }) as T);

      await expect(runChatGptJob(job(), { sessionTokenPath, pageEvaluator })).rejects.toThrow(ProError);
    });
  });

  test("fails early when the CDP ChatGPT page is logged out", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: false,
          status: 200,
          body: "ChatGPT page session did not include an access token.",
          code: "CHATGPT_PAGE_LOGGED_OUT",
        }) as T);

      await expect(runChatGptJob(job(), { sessionTokenPath, pageEvaluator })).rejects.toThrow(
        "The ChatGPT CDP page is not logged in.",
      );
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

function conversationStream(text: string): string {
  return [
    `data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[${JSON.stringify(text)}]},"status":"finished_successfully"}}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}
