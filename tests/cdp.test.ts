import { afterEach, describe, expect, test } from "bun:test";
import {
  evaluateInCdpPage,
  getCookiesFromCdp,
  pruneVolatileCookiesFromCdp,
  recoverCookieBloatInCdp,
} from "../src/cdp";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

describe("CDP helpers", () => {
  test("falls back to browser-level Storage.getCookies when no page target is listed", async () => {
    const methods: string[] = [];
    installFakeCdp({
      pageTargets: [],
      onCommand(method) {
        methods.push(method);
        if (method === "Network.getCookies") {
          return { error: { code: -32601, message: "'Network.getCookies' wasn't found" } };
        }
        if (method === "Storage.getCookies") {
          return {
            result: {
              cookies: [
                cookie("__cf_bm", "chatgpt.com"),
                cookie("unrelated", "example.com"),
              ],
            },
          };
        }
        return { result: {} };
      },
    });

    const cookies = await getCookiesFromCdp("http://127.0.0.1:9222", ["https://chatgpt.com/"]);

    expect(methods).toEqual(["Network.getCookies", "Storage.getCookies"]);
    expect(cookies.map((stored) => stored.name)).toEqual(["__cf_bm"]);
  });

  test("page evaluation fails clearly when CDP has no inspectable page target", async () => {
    installFakeCdp({
      pageTargets: [],
      onCommand() {
        return { result: {} };
      },
    });

    await expect(evaluateInCdpPage("http://127.0.0.1:9222", "location.href")).rejects.toThrow(
      "No inspectable page is available",
    );
  });

  test("prunes volatile conversation cookies from a live CDP profile", async () => {
    const deleted: Array<Record<string, unknown> | undefined> = [];
    installFakeCdp({
      pageTargets: [{ type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://fake-page" }],
      onCommand(method, params) {
        if (method === "Network.getCookies") {
          return {
            result: {
              cookies: [
                cookie("__Secure-next-auth.session-token", "chatgpt.com"),
                cookie("conv_key_abc", "chatgpt.com"),
                cookie("conv_key_def", "chatgpt.com"),
              ],
            },
          };
        }
        if (method === "Network.deleteCookies") {
          deleted.push(params);
          return { result: {} };
        }
        return { result: {} };
      },
    });

    const result = await pruneVolatileCookiesFromCdp("http://127.0.0.1:9222", ["https://chatgpt.com/"]);

    expect(result.checked).toBe(3);
    expect(result.deleted).toBe(2);
    expect(deleted).toEqual([
      { name: "conv_key_abc", domain: "chatgpt.com", path: "/" },
      { name: "conv_key_def", domain: "chatgpt.com", path: "/" },
    ]);
  });

  test("cookie bloat recovery prunes volatile cookies and reloads ChatGPT", async () => {
    const methods: string[] = [];
    installFakeCdp({
      pageTargets: [{ type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://fake-page" }],
      onCommand(method) {
        methods.push(method);
        if (method === "Network.getCookies") {
          return {
            result: {
              cookies: [
                cookie("__Secure-next-auth.session-token", "chatgpt.com"),
                cookie("conv_key_abc", "chatgpt.com"),
              ],
            },
          };
        }
        return { result: {} };
      },
    });

    const result = await recoverCookieBloatInCdp("http://127.0.0.1:9222", ["https://chatgpt.com/"], 10);

    expect(result.deleted).toBe(1);
    expect(result.navigated).toBe(true);
    expect(methods).toEqual([
      "Network.getCookies",
      "Network.deleteCookies",
      "Page.enable",
      "Page.navigate",
    ]);
  });
});

function cookie(name: string, domain: string): {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
} {
  return { name, value: "redacted-test-value", domain, path: "/", secure: true };
}

function installFakeCdp(options: {
  pageTargets: Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  onCommand: (
    method: string,
    params?: Record<string, unknown>,
  ) => { result?: unknown; error?: { code: number; message: string } };
}): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith("/json")) {
      return Response.json(options.pageTargets);
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
      const message = JSON.parse(raw) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      const response = { id: message.id, ...options.onCommand(message.method, message.params) };
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
