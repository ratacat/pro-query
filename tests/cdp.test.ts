import { afterEach, describe, expect, test } from "bun:test";
import { evaluateInCdpPage, getCookiesFromCdp } from "../src/cdp";

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
