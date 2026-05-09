import { EXIT, ProError } from "./errors";
import { isVolatileCookieName } from "./cookies";

interface JsonRpcResponse<T> {
  id?: number;
  result?: T;
  error?: { code: number; message: string };
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
}

export async function getCookiesFromCdp(
  cdpBase: string,
  urls: string[],
  timeoutMs = 10_000,
): Promise<CdpCookie[]> {
  const wsUrl = await resolveCdpWebSocketUrl(cdpBase);
  const client = await CdpClient.connect(wsUrl, timeoutMs);
  try {
    return await readCookiesForUrls(client, urls);
  } finally {
    client.close();
  }
}

export interface CookiePruneResult {
  checked: number;
  deleted: number;
  names: string[];
}

export async function pruneVolatileCookiesFromCdp(
  cdpBase: string,
  urls: string[],
  timeoutMs = 10_000,
): Promise<CookiePruneResult> {
  const wsUrl = await resolveCdpWebSocketUrl(cdpBase);
  const client = await CdpClient.connect(wsUrl, timeoutMs);
  try {
    const cookies = await readCookiesForUrls(client, urls);
    const volatileCookies = cookies.filter((cookie) => isVolatileCookieName(cookie.name));
    for (const cookie of volatileCookies) {
      await client.send<unknown>("Network.deleteCookies", {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path || "/",
      });
    }
    return {
      checked: cookies.length,
      deleted: volatileCookies.length,
      names: [...new Set(volatileCookies.map((cookie) => cookie.name))].sort(),
    };
  } finally {
    client.close();
  }
}

export interface CookieBloatRecoveryResult extends CookiePruneResult {
  navigated: boolean;
}

export async function recoverCookieBloatInCdp(
  cdpBase: string,
  urls: string[],
  timeoutMs = 10_000,
): Promise<CookieBloatRecoveryResult> {
  const pruned = await pruneVolatileCookiesFromCdp(cdpBase, urls, timeoutMs);
  if (pruned.deleted === 0) return { ...pruned, navigated: false };

  await navigateCdpPage(cdpBase, "https://chatgpt.com/", timeoutMs);
  await sleepMs(Math.min(1500, timeoutMs));
  return { ...pruned, navigated: true };
}

export async function evaluateInCdpPage<T>(
  cdpBase: string,
  expression: string,
  timeoutMs = 10_000,
): Promise<T> {
  const wsUrl = await resolveRequiredPageWebSocketUrl(cdpBase);
  const client = await CdpClient.connect(wsUrl, timeoutMs);
  try {
    const response = await client.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new ProError(
        "CDP_EVALUATION_FAILED",
        response.exceptionDetails.text ?? "Chrome page evaluation failed.",
        {
          exitCode: EXIT.auth,
          suggestions: ["Open the logged-in ChatGPT page and retry auth capture."],
        },
      );
    }
    return response.result?.value as T;
  } finally {
    client.close();
  }
}

async function resolveRequiredPageWebSocketUrl(cdpBase: string): Promise<string> {
  const base = cdpBase.replace(/\/$/, "");
  const pageWsUrl = await resolvePageWebSocketUrl(base);
  if (pageWsUrl) return pageWsUrl;

  await resolveBrowserWebSocketUrl(base);
  throw new ProError("CHATGPT_PAGE_MISSING", `No inspectable page is available over CDP at ${base}.`, {
    exitCode: EXIT.auth,
    suggestions: [
      "Open the Chrome command from pro-cli auth command.",
      "Confirm the CDP Chrome window has a https://chatgpt.com/ tab.",
    ],
    details: { cdpBase: base },
  });
}

async function resolveCdpWebSocketUrl(cdpBase: string): Promise<string> {
  const base = cdpBase.replace(/\/$/, "");
  const pageWsUrl = await resolvePageWebSocketUrl(base);
  if (pageWsUrl) return pageWsUrl;

  return resolveBrowserWebSocketUrl(base);
}

export async function callBrowserCdp<T>(
  cdpBase: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<T> {
  const wsUrl = await resolveBrowserWebSocketUrl(cdpBase.replace(/\/$/, ""));
  const client = await CdpClient.connect(wsUrl, timeoutMs);
  try {
    return await client.send<T>(method, params);
  } finally {
    client.close();
  }
}

export async function navigateCdpPage(
  cdpBase: string,
  url: string,
  timeoutMs = 10_000,
): Promise<void> {
  const wsUrl = await resolveRequiredPageWebSocketUrl(cdpBase);
  const client = await CdpClient.connect(wsUrl, timeoutMs);
  try {
    await client.send<unknown>("Page.enable");
    await client.send<unknown>("Page.navigate", { url });
  } finally {
    client.close();
  }
}

export async function findChatGptTargetId(cdpBase: string): Promise<string | null> {
  const base = cdpBase.replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetch(`${base}/json`);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const targets = (await response.json().catch(() => [])) as Array<{
    id?: string;
    type?: string;
    url?: string;
  }>;
  const chatgpt = targets.find((t) => t.type === "page" && t.url?.startsWith("https://chatgpt.com/"));
  return chatgpt?.id ?? null;
}

async function resolveBrowserWebSocketUrl(base: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${base}/json/version`);
  } catch (error) {
    throw new ProError("CDP_UNAVAILABLE", `Cannot connect to Chrome CDP at ${base}.`, {
      exitCode: EXIT.auth,
      suggestions: [
        "Open Chrome with --remote-debugging-port=9222.",
        "Pass --cdp http://127.0.0.1:<port> if Chrome uses a different CDP port.",
      ],
      cause: error,
    });
  }
  if (!response.ok) {
    throw new ProError("CDP_UNAVAILABLE", `Chrome CDP returned HTTP ${response.status}.`, {
      exitCode: EXIT.auth,
      suggestions: ["Check the CDP URL and remote debugging port."],
    });
  }
  const payload = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!payload.webSocketDebuggerUrl) {
    throw new ProError("CDP_UNAVAILABLE", "Chrome CDP did not expose a browser websocket.", {
      exitCode: EXIT.auth,
      suggestions: ["Use the browser-level CDP endpoint from /json/version."],
    });
  }
  return payload.webSocketDebuggerUrl;
}

function filterCookiesForUrls(cookies: CdpCookie[], urls: string[]): CdpCookie[] {
  return cookies.filter((cookie) => urls.some((url) => cookieAppliesToUrl(cookie, url)));
}

async function readCookiesForUrls(client: CdpClient, urls: string[]): Promise<CdpCookie[]> {
  try {
    const response = await client.send<{ cookies: CdpCookie[] }>("Network.getCookies", { urls });
    return filterCookiesForUrls(response.cookies ?? [], urls);
  } catch (error) {
    if (!isMissingCdpMethod(error)) throw error;
    const response = await client.send<{ cookies: CdpCookie[] }>("Storage.getCookies");
    return filterCookiesForUrls(response.cookies ?? [], urls);
  }
}

function cookieAppliesToUrl(cookie: CdpCookie, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const domain = (cookie.domain || "").replace(/^\./, "").toLowerCase();
  if (!domain) return false;
  if (host !== domain && !host.endsWith(`.${domain}`)) return false;

  const cookiePath = cookie.path || "/";
  return parsed.pathname.startsWith(cookiePath) || cookiePath === "/";
}

function isMissingCdpMethod(error: unknown): boolean {
  return (
    error instanceof ProError &&
    error.code === "CDP_COMMAND_FAILED" &&
    error.details?.cdpCode === -32601
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolvePageWebSocketUrl(base: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`${base}/json`);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const targets = (await response.json().catch(() => [])) as Array<{
    type?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
  }>;
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  const chatgpt = pages.find((target) => target.url?.startsWith("https://chatgpt.com/"));
  return chatgpt?.webSocketDebuggerUrl ?? pages[0]?.webSocketDebuggerUrl ?? null;
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private constructor(
    private readonly socket: WebSocket,
    private readonly timeoutMs: number,
  ) {
    this.socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    this.socket.addEventListener("error", () => this.rejectAll("CDP websocket error."));
    this.socket.addEventListener("close", () => this.rejectAll("CDP websocket closed."));
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket open timed out.")), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP websocket failed to open."));
      });
    }).catch((error) => {
      throw new ProError("CDP_UNAVAILABLE", "Cannot open Chrome CDP websocket.", {
        exitCode: EXIT.auth,
        suggestions: ["Confirm Chrome is running with remote debugging enabled."],
        cause: error,
      });
    });
    return new CdpClient(socket, timeoutMs);
  }

  async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ProError("CDP_TIMEOUT", `Chrome CDP command ${method} timed out.`, {
            exitCode: EXIT.timeout,
            suggestions: ["Retry auth capture or restart the CDP Chrome instance."],
          }),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    });
    this.socket.send(payload);
    return result;
  }

  close(): void {
    this.socket.close();
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as JsonRpcResponse<unknown>;
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new ProError("CDP_COMMAND_FAILED", message.error.message, {
          exitCode: EXIT.auth,
          suggestions: ["Retry with a fresh logged-in Chrome/CDP session."],
          details: { cdpCode: message.error.code },
        }),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}
