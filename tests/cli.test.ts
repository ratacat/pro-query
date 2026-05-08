import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { runCli } from "../src/app";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "pro-query-test-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function run(args: string[], options: { tty?: boolean; home?: string } = {}): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdoutIsTTY: options.tty ?? false,
    env: { PRO_CLI_HOME: options.home },
    cwd: process.cwd(),
  });
  return { code, stdout, stderr };
}

describe("robot-mode CLI", () => {
  test("prints compact help with no args for TTY users", async () => {
    const result = await run([], { tty: true });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pro-cli: ChatGPT Pro CLI");
    expect(result.stdout.length).toBeLessThan(160);
    expect(result.stderr).toBe("");
  });

  test("prints compact help with --help for TTY users", async () => {
    const result = await run(["--help"], { tty: true });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pro-cli: ChatGPT Pro CLI");
    expect(result.stdout.length).toBeLessThan(160);
    expect(result.stderr).toBe("");
  });

  test("auto-switches to JSON when stdout is not a TTY", async () => {
    const result = await run([], { tty: false });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.data.text).toContain("auth capture");
  });

  test("prints version for install verification", async () => {
    const result = await run(["--version"], { tty: false });

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^pro-cli \d+\.\d+\.\d+\n$/);
    expect(result.stderr).toBe("");
  });

  test("emits structured JSON errors and invalid-args exit code", async () => {
    const result = await run(["missing-command", "--json"], { tty: true });

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("INVALID_ARGS");
    expect(payload.error.suggestions).toContain("Run pro-cli help.");
  });

  test("setup gives a safe first-run path without secrets", async () => {
    await withHome(async (home) => {
      const result = await run(["setup", "--json"], { tty: true, home });

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("secret");
      const payload = JSON.parse(result.stdout);
      expect(payload.data.ready).toBe(false);
      expect(payload.data.steps.map((step: { id: string }) => step.id)).toEqual([
        "install",
        "open-chatgpt",
        "capture-auth",
        "smoke-test",
      ]);
      expect(payload.data.steps[1].command).toContain("chrome-profile");
      expect(payload.data.steps[2].command).toContain("pro-cli auth capture");
      expect(payload.data.safety.rawValuesPrinted).toBe(false);
    });
  });

  test("setup is readable for TTY users", async () => {
    await withHome(async (home) => {
      const result = await run(["setup"], { tty: true, home });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("pro-cli needs a logged-in ChatGPT browser session");
      expect(result.stdout).toContain("[todo] open-chatgpt");
      expect(result.stdout).toContain("pro-cli auth capture");
      expect(result.stdout).not.toContain("{\"ready\"");
    });
  });

  test("auth command prints dedicated profile launch and capture commands", async () => {
    await withHome(async (home) => {
      const result = await run(["auth", "command", "--port", "9333", "--json"], {
        tty: true,
        home,
      });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.command).toContain("chrome-profile");
      expect(payload.data.command).toContain("9333");
      expect(payload.data.captureCommand).toBe("pro-cli auth capture --cdp http://127.0.0.1:9333 --json");
      expect(payload.data.safety).toContain("dedicated");
    });
  });

  test("reports missing auth without raw cookie values", async () => {
    await withHome(async (home) => {
      const result = await run(["auth", "status", "--json"], { tty: true, home });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.status).toBe("missing");
      expect(payload.data.rawValuesPrinted).toBe(false);
      expect(payload.data.cookieCount).toBe(0);
    });
  });

  test("summarizes existing cookie export without printing values", async () => {
    await withHome(async (home) => {
      const cookiePath = join(home, "cookies", "chatgpt.json");
      await mkdir(join(home, "cookies"), { recursive: true });
      await writeFile(
        cookiePath,
        JSON.stringify({
          version: 1,
          generatedAt: new Date().toISOString(),
          source: "pro-cli-cdp",
          targetUrl: "https://chatgpt.com/",
          origins: ["https://chatgpt.com/"],
          cookies: [
            {
              name: "__Secure-next-auth.session-token",
              value: "secret-value",
              domain: "chatgpt.com",
              path: "/",
              secure: true,
              httpOnly: true,
            },
          ],
        }),
      );

      const result = await run(["auth", "status", "--json"], { tty: true, home });

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("secret-value");
      const payload = JSON.parse(result.stdout);
      expect(payload.data.status).toBe("present");
      expect(payload.data.cookieCount).toBe(1);
      expect(payload.data.names).toEqual(["__Secure-next-auth.session-token"]);
    });
  });

  test("creates durable async jobs with redacted prompt preview", async () => {
    await withHome(async (home) => {
      const submit = await run(["submit", "hello", "from", "agent", "--no-start", "--json"], {
        tty: true,
        home,
      });

      expect(submit.code).toBe(0);
      const created = JSON.parse(submit.stdout);
      const jobId = created.data.job.id;
      expect(created.data.job.status).toBe("queued");
      expect(created.data.daemon.started).toBe(false);
      expect(created.data.job.prompt).toBe("");
      expect(created.data.job.promptPreview).toBe("hello from agent");

      const status = await run(["status", jobId, "--json"], { tty: true, home });
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout).data.job.id).toBe(jobId);
    });
  });

  test("run reports missing session token without durable job storage", async () => {
    await withHome(async (home) => {
      const result = await run(["run", "hello", "--json"], { tty: true, home });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.job.status).toBe("failed");
      expect(payload.data.error.code).toBe("SESSION_TOKEN_MISSING");
      await expect(access(join(home, "jobs.sqlite"))).rejects.toThrow();
    });
  });

  test("daemon status is stopped before startup", async () => {
    await withHome(async (home) => {
      const result = await run(["daemon", "status", "--json"], { tty: true, home });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.daemon.state).toBe("stopped");
      expect(payload.data.daemon.home).toBe(home);
      expect(payload.data.daemon.endpointPath).toContain("pro-cli-");
    });
  });

  test("run executes without durable job storage and returns the full result", async () => {
    await withHome(async (home) => {
      await mkdir(join(home, "tokens"), { recursive: true });
      await writeFile(
        join(home, "tokens", "chatgpt-session.json"),
        JSON.stringify({
          version: 1,
          generatedAt: new Date().toISOString(),
          source: "pro-cli-cdp-page",
          accessToken: fakeJwt(),
          accountId: "acct_test",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );

      let expression = "";
      installFakeCdp(conversationStream("OK"), (script) => {
        expression = script;
      });

      const result = await run(
        [
          "run",
          "hello",
          "--json",
          "--reasoning",
          "high",
          "--verbosity",
          "low",
          "--timeout",
          "1000",
          "--retries",
          "1",
          "--retry-delay",
          "0",
        ],
        { tty: true, home },
      );

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.job.status).toBe("succeeded");
      expect(payload.data.job.prompt).toBe("");
      expect(payload.data.job.options.temporary).toBe(true);
      expect(payload.data.result).toBe("OK");
      await expect(access(join(home, "jobs.sqlite"))).rejects.toThrow();
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody.model).toBe("gpt-5-5-thinking");
      expect(requestBody.thinking_effort).toBe("max");
      expect(requestBody.history_and_training_disabled).toBe(true);
      expect(requestBody).not.toHaveProperty("text");
    });
  });

  test("run can opt into saved and continued conversations", async () => {
    await withHome(async (home) => {
      await writeSessionToken(home);
      let expression = "";
      installFakeCdp(conversationStream("OK"), (script) => {
        expression = script;
      });

      const result = await run(
        [
          "run",
          "continue this",
          "--json",
          "--save",
          "--conversation",
          "conv_123",
          "--parent",
          "msg_456",
          "--reasoning",
          "extended",
        ],
        { tty: true, home },
      );

      expect(result.code).toBe(0);
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody.conversation_id).toBe("conv_123");
      expect(requestBody.parent_message_id).toBe("msg_456");
      expect(requestBody.model).toBe("gpt-5-5-thinking");
      expect(requestBody).not.toHaveProperty("history_and_training_disabled");
      expect(requestBody.thinking_effort).toBe("extended");
    });
  });

  test("continuing a conversation requires conversation and parent ids together", async () => {
    await withHome(async (home) => {
      const result = await run(["submit", "hello", "--conversation", "conv_123", "--json"], {
        tty: true,
        home,
      });

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("both ids");
    });
  });

  test("run prints plain text result for TTY users", async () => {
    await withHome(async (home) => {
      await mkdir(join(home, "tokens"), { recursive: true });
      await writeFile(
        join(home, "tokens", "chatgpt-session.json"),
        JSON.stringify({
          version: 1,
          generatedAt: new Date().toISOString(),
          source: "pro-cli-cdp-page",
          accessToken: fakeJwt(),
          accountId: "acct_test",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );
      installFakeCdp(conversationStream("OK"));

      const result = await run(["run", "hello"], { tty: true, home });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("OK\n");
    });
  });

  test("rejects unsupported request flags instead of silently ignoring them", async () => {
    await withHome(async (home) => {
      const result = await run(["submit", "hello", "--temperature", "0.2", "--json"], {
        tty: true,
        home,
      });

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("Unsupported --temperature");
    });
  });

  test("doctor refuses ready when the CDP ChatGPT page is logged out", async () => {
    await withHome(async (home) => {
      await writeSessionToken(home);
      installFakeCdpValue({
        status: 200,
        hasAccessToken: false,
        origin: "https://chatgpt.com",
      });

      const result = await run(["doctor", "--json", "--timeout", "1000"], { tty: true, home });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.auth.tokenStatus).toBe("present");
      expect(payload.data.browserSession.status).toBe("logged_out");
      expect(payload.data.ready).toBe(false);
      expect(payload.data.transport.status).toBe("auth_required");
      expect(payload.data.next.command).toContain("pro-cli auth capture");
    });
  });

  test("doctor reports ready only when stored auth and live browser session are both present", async () => {
    await withHome(async (home) => {
      await writeSessionToken(home);
      installFakeCdpValue({
        status: 200,
        hasAccessToken: true,
        origin: "https://chatgpt.com",
      });

      const result = await run(["doctor", "--json", "--cdp", "http://127.0.0.1:9555"], {
        tty: true,
        home,
      });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.browserSession.status).toBe("present");
      expect(payload.data.browserSession.cdpBase).toBe("http://127.0.0.1:9555");
      expect(payload.data.ready).toBe(true);
      expect(payload.data.transport.status).toBe("configured");
      expect(payload.data.next.command).toContain("--cdp http://127.0.0.1:9555");
      expect(result.stdout).not.toContain("header.");
    });
  });
});

async function writeSessionToken(home: string): Promise<void> {
  await mkdir(join(home, "tokens"), { recursive: true });
  await writeFile(
    join(home, "tokens", "chatgpt-session.json"),
    JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "pro-cli-cdp-page",
      accessToken: fakeJwt(),
      accountId: "acct_test",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  );
}

function fakeJwt(): string {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
  };
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");
}

function installFakeCdp(body: string, onExpression?: (expression: string) => void): void {
  installFakeCdpValue({ ok: true, status: 200, body }, onExpression);
}

function installFakeCdpValue(value: unknown, onExpression?: (expression: string) => void): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith("/json")) {
      return Response.json([
        {
          type: "page",
          url: "https://chatgpt.com/",
          webSocketDebuggerUrl: "ws://fake-chatgpt-page",
        },
      ]);
    }
    if (target.endsWith("/json/version")) {
      return Response.json({ webSocketDebuggerUrl: "ws://fake-browser" });
    }
    return new Response("unexpected fetch", { status: 500 });
  }) as unknown as typeof fetch;

  class FakeWebSocket extends EventTarget {
    constructor(_url: string) {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as { id: number; params?: { expression?: string } };
      onExpression?.(message.params?.expression ?? "");
      const response = {
        id: message.id,
        result: {
          result: { value },
        },
      };
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(response) })),
      );
    }

    close(): void {
      this.dispatchEvent(new Event("close"));
    }
  }

  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

function requestBodyFromExpression(expression: string): Record<string, unknown> {
  const marker = '})("https://chatgpt.com/backend-api/f/conversation", ';
  const start = expression.lastIndexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const bodyEnd = expression.lastIndexOf(', "acct_test")');
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return JSON.parse(expression.slice(bodyStart, bodyEnd)) as Record<string, unknown>;
}

function conversationStream(text: string): string {
  return [
    `data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[${JSON.stringify(text)}]},"status":"finished_successfully"}}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}
