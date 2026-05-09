import { afterEach, describe, expect, test } from "bun:test";
import { ProError } from "../src/errors";
import {
  callBrowserCdp,
  evaluateInCdpPage,
  findChatGptTargetId,
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

    try {
      await evaluateInCdpPage("http://127.0.0.1:9222", "location.href");
      throw new Error("Expected CHATGPT_PAGE_MISSING.");
    } catch (error) {
      // Strengthen: assert exact ProError code + actionable suggestions, not
      // just substring match on the message (which couples to copy text).
      expect(error).toBeInstanceOf(ProError);
      const proError = error as ProError;
      expect(proError.code).toBe("CHATGPT_PAGE_MISSING");
      expect(proError.suggestions.some((s) => s.includes("auth command"))).toBe(true);
      expect(proError.details?.cdpBase).toBe("http://127.0.0.1:9222");
    }
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

  test("evaluateInCdpPage returns the value from Runtime.evaluate", async () => {
    installFakeCdp({
      pageTargets: [{ type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://fake-page" }],
      onCommand(method) {
        if (method === "Runtime.evaluate") {
          return { result: { result: { value: { ok: true, status: 200, payload: "hello" } } } };
        }
        return { result: {} };
      },
    });

    const result = await evaluateInCdpPage<{ ok: boolean; status: number; payload: string }>(
      "http://127.0.0.1:9222",
      "(() => ({ ok: true, status: 200, payload: 'hello' }))()",
    );
    expect(result).toEqual({ ok: true, status: 200, payload: "hello" });
  });

  test("evaluateInCdpPage surfaces page-side exceptions as CDP_EVALUATION_FAILED", async () => {
    installFakeCdp({
      pageTargets: [{ type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://fake-page" }],
      onCommand(method) {
        if (method === "Runtime.evaluate") {
          return {
            result: {
              exceptionDetails: { text: "ReferenceError: undefinedThing is not defined" },
            },
          };
        }
        return { result: {} };
      },
    });

    try {
      await evaluateInCdpPage("http://127.0.0.1:9222", "throw new Error('boom')");
      throw new Error("Expected CDP_EVALUATION_FAILED.");
    } catch (error) {
      expect(error).toBeInstanceOf(ProError);
      const proError = error as ProError;
      expect(proError.code).toBe("CDP_EVALUATION_FAILED");
      expect(proError.message).toContain("ReferenceError");
    }
  });

  test("evaluateInCdpPage surfaces CDP method errors via CDP_COMMAND_FAILED", async () => {
    installFakeCdp({
      pageTargets: [{ type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://fake-page" }],
      onCommand(method) {
        if (method === "Runtime.evaluate") {
          return { error: { code: -32000, message: "Cannot find context" } };
        }
        return { result: {} };
      },
    });

    try {
      await evaluateInCdpPage("http://127.0.0.1:9222", "noop");
      throw new Error("Expected CDP_COMMAND_FAILED.");
    } catch (error) {
      expect(error).toBeInstanceOf(ProError);
      expect((error as ProError).code).toBe("CDP_COMMAND_FAILED");
    }
  });

  test("cookie bloat recovery does NOT navigate when no volatile cookies exist", async () => {
    // Regression guard: blindly reloading the tab on every cookie scan would
    // disrupt logged-in state and waste time. Recovery must be a no-op when
    // there is nothing to prune.
    const methods: string[] = [];
    installFakeCdp({
      pageTargets: [{ type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://fake-page" }],
      onCommand(method) {
        methods.push(method);
        if (method === "Network.getCookies") {
          return {
            result: {
              cookies: [cookie("__Secure-next-auth.session-token", "chatgpt.com")],
            },
          };
        }
        return { result: {} };
      },
    });

    const result = await recoverCookieBloatInCdp("http://127.0.0.1:9222", ["https://chatgpt.com/"], 10);

    expect(result.deleted).toBe(0);
    expect(result.navigated).toBe(false);
    expect(methods).toEqual(["Network.getCookies"]);
    expect(methods).not.toContain("Page.navigate");
    expect(methods).not.toContain("Page.enable");
  });

  test("pruneVolatileCookiesFromCdp filters out cookies on non-target domains before deleting", async () => {
    // The URL filter (cookieAppliesToUrl) must drop unrelated cookies so we
    // never delete cookies for sites we don't own.
    const deleted: Array<{ name?: string; domain?: string }> = [];
    installFakeCdp({
      pageTargets: [{ type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://fake-page" }],
      onCommand(method, params) {
        if (method === "Network.getCookies") {
          return {
            result: {
              cookies: [
                cookie("conv_key_chatgpt", "chatgpt.com"),
                cookie("conv_key_other", "evil.example"),
              ],
            },
          };
        }
        if (method === "Network.deleteCookies") {
          deleted.push(params as { name?: string; domain?: string });
          return { result: {} };
        }
        return { result: {} };
      },
    });

    const result = await pruneVolatileCookiesFromCdp("http://127.0.0.1:9222", ["https://chatgpt.com/"]);
    expect(result.checked).toBe(1); // only the chatgpt.com cookie matched the URL filter
    expect(result.deleted).toBe(1);
    expect(deleted).toEqual([{ name: "conv_key_chatgpt", domain: "chatgpt.com", path: "/" }]);
  });

  test("findChatGptTargetId returns the id of a chatgpt.com page target", async () => {
    installFakeCdp({
      pageTargets: [
        { type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://fake-other" },
        { type: "page", url: "https://chatgpt.com/c/abc", webSocketDebuggerUrl: "ws://fake-chatgpt" },
      ],
      onCommand() {
        return { result: {} };
      },
    });
    // installFakeCdp does not surface ids on its targets; verify a chatgpt.com
    // tab is selectable. We extend the fake to return ids when /json is fetched.
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/json")) {
        return Response.json([
          { id: "TAB1", type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://fake-other" },
          { id: "TAB2", type: "page", url: "https://chatgpt.com/c/abc", webSocketDebuggerUrl: "ws://fake-chatgpt" },
        ]);
      }
      if (target.endsWith("/json/version")) {
        return Response.json({ webSocketDebuggerUrl: "ws://fake-browser" });
      }
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const id = await findChatGptTargetId("http://127.0.0.1:9222");
    expect(id).toBe("TAB2");
  });

  test("findChatGptTargetId returns null when no chatgpt.com tab exists", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/json")) {
        return Response.json([
          { id: "TAB1", type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://fake-other" },
        ]);
      }
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const id = await findChatGptTargetId("http://127.0.0.1:9222");
    expect(id).toBeNull();
  });

  test("findChatGptTargetId returns null on CDP fetch errors (caller decides what to do)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const id = await findChatGptTargetId("http://127.0.0.1:9222");
    expect(id).toBeNull();
  });

  test("callBrowserCdp dispatches the requested method to the browser endpoint", async () => {
    let observedMethod = "";
    let observedParams: Record<string, unknown> | undefined;
    installFakeCdp({
      pageTargets: [],
      onCommand(method, params) {
        observedMethod = method;
        observedParams = params;
        if (method === "Browser.getWindowForTarget") {
          return { result: { windowId: 12345, bounds: { left: 10, top: 20, width: 800, height: 600 } } };
        }
        return { result: {} };
      },
    });

    const result = await callBrowserCdp<{ windowId: number; bounds: Record<string, number> }>(
      "http://127.0.0.1:9222",
      "Browser.getWindowForTarget",
      { targetId: "TAB1" },
    );
    expect(observedMethod).toBe("Browser.getWindowForTarget");
    expect(observedParams).toEqual({ targetId: "TAB1" });
    expect(result.windowId).toBe(12345);
    expect(result.bounds).toEqual({ left: 10, top: 20, width: 800, height: 600 });
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
