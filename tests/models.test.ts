import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { listModels } from "../src/models";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function withTokenFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pro-model-test-"));
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

describe("model discovery", () => {
  test("falls back to static models when no session token is available", async () => {
    const result = await listModels({ sessionTokenPath: "/tmp/pro-query-missing-token.json" });

    expect(result.source).toBe("static");
    expect(result.warning).toContain("No captured ChatGPT session token");
    expect(result.models.map((model) => model.id)).toContain("auto");
  });

  test("loads live ChatGPT model catalog with bearer auth", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let authHeader = "";
      let accountHeader = "";
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        authHeader = headers.get("authorization") ?? "";
        accountHeader = headers.get("chatgpt-account-id") ?? "";
        return Response.json({
          default_model_slug: "gpt-5-5",
          model_picker_version: 2,
          models: [
            {
              slug: "gpt-5-5",
              title: "GPT-5.5",
              max_tokens: 272000,
              reasoning_type: "reasoning",
              configurable_thinking_effort: true,
              thinking_efforts: [
                { thinking_effort: "min", short_label: "Light" },
                { thinking_effort: "standard", short_label: "Standard" },
                { thinking_effort: "max", short_label: "Heavy" },
              ],
              enabled_tools: [{ type: "python" }, { type: "web" }],
            },
          ],
        });
      }) as unknown as typeof fetch;

      const result = await listModels({ sessionTokenPath });

      expect(authHeader).toStartWith("Bearer ");
      expect(accountHeader).toBe("acct_test");
      expect(result.source).toBe("live");
      expect(result.defaultModel).toBe("gpt-5-5");
      expect(result.modelPickerVersion).toBe(2);
      expect(result.models[1]).toMatchObject({
        id: "gpt-5-5",
        label: "GPT-5.5",
        default: true,
        maxTokens: 272000,
        reasoningLevels: ["min", "standard", "max"],
        enabledTools: ["python", "web"],
      });
    });
  });
});

function fakeJwt(): string {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
  };
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");
}
