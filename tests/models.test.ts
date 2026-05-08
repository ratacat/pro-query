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
    expect(result.defaultModel).toBe("gpt-5-5-pro");
    expect(result.models.map((model) => model.id)).not.toContain("auto");
    expect(result.models.map((model) => model.id)).toContain("gpt-5-5-pro");
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
              slug: "gpt-5-5-pro",
              title: "GPT-5.5 Pro",
              max_tokens: 272000,
              reasoning_type: "pro",
              configurable_thinking_effort: true,
              thinking_efforts: [
                { thinking_effort: "standard", short_label: "Standard" },
                { thinking_effort: "extended", short_label: "Extended" },
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
      expect(result.defaultModel).toBe("gpt-5-5-pro");
      expect(result.chatgptDefaultModel).toBe("gpt-5-5");
      expect(result.modelPickerVersion).toBe(2);
      expect(result.models[0]).toMatchObject({
        id: "gpt-5-5-pro",
        label: "GPT-5.5 Pro",
        default: true,
        maxTokens: 272000,
        reasoningLevels: ["standard", "extended"],
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
