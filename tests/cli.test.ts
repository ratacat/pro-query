import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { runCli } from "../src/app";

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
    env: { PRO_HOME: options.home },
    cwd: process.cwd(),
  });
  return { code, stdout, stderr };
}

describe("robot-mode CLI", () => {
  test("prints compact help with no args for TTY users", async () => {
    const result = await run([], { tty: true });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pro: ChatGPT Pro CLI");
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

  test("emits structured JSON errors and invalid-args exit code", async () => {
    const result = await run(["missing-command", "--json"], { tty: true });

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("INVALID_ARGS");
    expect(payload.error.suggestions).toContain("Run pro help.");
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
          source: "pro-cdp",
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
      const submit = await run(["submit", "hello", "from", "agent", "--json"], {
        tty: true,
        home,
      });

      expect(submit.code).toBe(0);
      const created = JSON.parse(submit.stdout);
      const jobId = created.data.job.id;
      expect(created.data.job.status).toBe("queued");
      expect(created.data.job.prompt).toBe("");
      expect(created.data.job.promptPreview).toBe("hello from agent");

      const status = await run(["status", jobId, "--json"], { tty: true, home });
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout).data.job.id).toBe(jobId);
    });
  });

  test("wait marks queued jobs failed when session token is missing", async () => {
    await withHome(async (home) => {
      const submit = await run(["submit", "hello", "--json"], { tty: true, home });
      const jobId = JSON.parse(submit.stdout).data.job.id;

      const wait = await run(["wait", jobId, "--json"], { tty: true, home });

      expect(wait.code).toBe(0);
      const payload = JSON.parse(wait.stdout);
      expect(payload.data.job.status).toBe("failed");
      expect(payload.data.error.code).toBe("SESSION_TOKEN_MISSING");
    });
  });
});
