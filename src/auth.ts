import { access } from "node:fs/promises";
import { EXIT, ProError } from "./errors";
import { evaluateInCdpPage, getCookiesFromCdp } from "./cdp";
import {
  chatGptOrigins,
  cookieSummary,
  loadCookieExport,
  toCookieExport,
  toNetscapeCookieJar,
} from "./cookies";
import type { RuntimePaths } from "./config";
import { writePrivateFile } from "./config";
import { isTokenFresh, loadSessionToken, toSessionTokenExport } from "./session-token";

export interface AuthStatus {
  status: "missing" | "present";
  cookieJsonPath: string;
  cookieJarPath: string;
  sessionTokenPath: string;
  tokenStatus: "missing" | "present" | "expired";
  tokenExpiresAt?: string;
  accountIdPresent: boolean;
  cookieCount: number;
  expiredCookieCount: number;
  domains: string[];
  names: string[];
  rawValuesPrinted: false;
}

export type BrowserSessionState = "present" | "logged_out" | "page_missing" | "cdp_unavailable";

export interface BrowserSessionStatus {
  status: BrowserSessionState;
  cdpBase: string;
  httpStatus?: number;
  pageOrigin?: string;
  errorCode?: string;
  message?: string;
  suggestions: string[];
  rawValuesPrinted: false;
}

export async function getAuthStatus(paths: RuntimePaths): Promise<AuthStatus> {
  try {
    await access(paths.cookieJsonPath);
  } catch {
    return {
      status: "missing",
      cookieJsonPath: paths.cookieJsonPath,
      cookieJarPath: paths.cookieJarPath,
      sessionTokenPath: paths.sessionTokenPath,
      tokenStatus: await readTokenStatus(paths.sessionTokenPath),
      accountIdPresent: await readAccountIdPresent(paths.sessionTokenPath),
      cookieCount: 0,
      expiredCookieCount: 0,
      domains: [],
      names: [],
      rawValuesPrinted: false,
    };
  }

  const cookieExport = await loadCookieExport(paths.cookieJsonPath);
  const summary = cookieSummary(cookieExport.cookies);
  return {
    status: "present",
    cookieJsonPath: paths.cookieJsonPath,
    cookieJarPath: paths.cookieJarPath,
    sessionTokenPath: paths.sessionTokenPath,
    ...(await tokenStatusFields(paths.sessionTokenPath)),
    cookieCount: summary.count,
    expiredCookieCount: summary.expired,
    domains: summary.domains,
    names: summary.names,
    rawValuesPrinted: false,
  };
}

export async function getBrowserSessionStatus(
  cdpBase: string,
  timeoutMs = 3_000,
): Promise<BrowserSessionStatus> {
  try {
    const result = await evaluateInCdpPage<{
      status: number;
      hasAccessToken: boolean;
      origin: string;
      code?: "CHATGPT_PAGE_MISSING";
    }>(
      cdpBase,
      `(async () => {
        if (location.origin !== "https://chatgpt.com") {
          return {
            status: 0,
            hasAccessToken: false,
            origin: location.origin,
            code: "CHATGPT_PAGE_MISSING"
          };
        }
        const res = await fetch("https://chatgpt.com/api/auth/session", { credentials: "include" });
        const json = await res.json().catch(() => null);
        return {
          status: res.status,
          hasAccessToken: typeof json?.accessToken === "string" && json.accessToken.length > 0,
          origin: location.origin
        };
      })()`,
      timeoutMs,
    );

    if (result?.code === "CHATGPT_PAGE_MISSING") {
      return {
        status: "page_missing",
        cdpBase,
        httpStatus: result.status,
        pageOrigin: result.origin,
        suggestions: [
          "Open the Chrome command from pro-cli auth command.",
          "Confirm the CDP tab is on https://chatgpt.com/.",
        ],
        rawValuesPrinted: false,
      };
    }

    if (result?.hasAccessToken) {
      return {
        status: "present",
        cdpBase,
        httpStatus: result.status,
        pageOrigin: result.origin,
        suggestions: [],
        rawValuesPrinted: false,
      };
    }

    return {
      status: "logged_out",
      cdpBase,
      httpStatus: result?.status,
      pageOrigin: result?.origin,
      suggestions: [
        "Sign in to ChatGPT in the CDP Chrome window.",
        `Run pro-cli auth capture --cdp ${cdpBase} --json after login.`,
      ],
      rawValuesPrinted: false,
    };
  } catch (error) {
    const proError = error instanceof ProError ? error : null;
    if (proError?.code === "CHATGPT_PAGE_MISSING") {
      return {
        status: "page_missing",
        cdpBase,
        errorCode: proError.code,
        message: proError.message,
        suggestions: proError.suggestions,
        rawValuesPrinted: false,
      };
    }
    return {
      status: "cdp_unavailable",
      cdpBase,
      errorCode: proError?.code ?? "CDP_UNAVAILABLE",
      message: error instanceof Error ? error.message : String(error),
      suggestions:
        proError?.suggestions.length ? proError.suggestions : ["Open Chrome with remote debugging enabled."],
      rawValuesPrinted: false,
    };
  }
}

export interface CaptureOptions {
  cdpBase: string;
  jsonPath: string;
  jarPath: string;
  tokenPath: string;
  timeoutMs?: number;
  dryRun?: boolean;
}

export async function captureAuth(options: CaptureOptions): Promise<AuthStatus> {
  if (options.dryRun) {
    throw new ProError("DRY_RUN", "Auth capture dry run does not read cookies.", {
      exitCode: EXIT.success,
      suggestions: ["Run without --dry-run to capture scoped ChatGPT cookies."],
    });
  }

  const cookies = await getCookiesFromCdp(
    options.cdpBase,
    chatGptOrigins(),
    options.timeoutMs ?? 10_000,
  );
  const cookieExport = toCookieExport(cookies);
  if (cookieExport.cookies.length === 0) {
    throw new ProError("NO_CHATGPT_COOKIES", "No ChatGPT/OpenAI cookies were found via CDP.", {
      exitCode: EXIT.auth,
      suggestions: [
        "Open https://chatgpt.com/ in the CDP Chrome window.",
        "Confirm the logged-in ChatGPT UI is visible.",
        "Retry pro-cli auth capture.",
      ],
    });
  }

  await writePrivateFile(options.jsonPath, `${JSON.stringify(cookieExport, null, 2)}\n`);
  await writePrivateFile(options.jarPath, toNetscapeCookieJar(cookieExport.cookies));
  const accessToken = await getSessionAccessTokenFromPage(options.cdpBase, options.timeoutMs ?? 10_000);
  const sessionToken = toSessionTokenExport(accessToken);
  await writePrivateFile(options.tokenPath, `${JSON.stringify(sessionToken, null, 2)}\n`);

  const summary = cookieSummary(cookieExport.cookies);
  return {
    status: "present",
    cookieJsonPath: options.jsonPath,
    cookieJarPath: options.jarPath,
    sessionTokenPath: options.tokenPath,
    tokenStatus: "present",
    ...(sessionToken.expiresAt ? { tokenExpiresAt: sessionToken.expiresAt } : {}),
    accountIdPresent: Boolean(sessionToken.accountId),
    cookieCount: summary.count,
    expiredCookieCount: summary.expired,
    domains: summary.domains,
    names: summary.names,
    rawValuesPrinted: false,
  };
}

export function defaultCdpBase(port: string | undefined, cdp: string | undefined): string {
  if (cdp) return cdp;
  return `http://127.0.0.1:${port ?? "9222"}`;
}

async function getSessionAccessTokenFromPage(cdpBase: string, timeoutMs: number): Promise<string> {
  const result = await evaluateInCdpPage<{ status: number; hasAccessToken: boolean; accessToken?: string }>(
    cdpBase,
    `fetch("/api/auth/session", { credentials: "include" }).then(async (res) => {
      const json = await res.json().catch(() => null);
      return {
        status: res.status,
        hasAccessToken: typeof json?.accessToken === "string",
        accessToken: typeof json?.accessToken === "string" ? json.accessToken : undefined
      };
    })`,
    timeoutMs,
  );
  if (result.status !== 200 || !result.hasAccessToken || !result.accessToken) {
    throw new ProError("SESSION_TOKEN_UNAVAILABLE", "ChatGPT page did not expose a session access token.", {
      exitCode: EXIT.auth,
      suggestions: [
        "Confirm the CDP tab is on https://chatgpt.com/ and logged in.",
        "Refresh the ChatGPT page and retry pro-cli auth capture.",
      ],
      details: { status: result.status },
    });
  }
  return result.accessToken;
}

async function tokenStatusFields(path: string): Promise<{
  tokenStatus: "missing" | "present" | "expired";
  tokenExpiresAt?: string;
  accountIdPresent: boolean;
}> {
  try {
    const token = await loadSessionToken(path);
    return {
      tokenStatus: isTokenFresh(token) ? "present" : "expired",
      ...(token.expiresAt ? { tokenExpiresAt: token.expiresAt } : {}),
      accountIdPresent: Boolean(token.accountId),
    };
  } catch {
    return { tokenStatus: "missing", accountIdPresent: false };
  }
}

async function readTokenStatus(path: string): Promise<"missing" | "present" | "expired"> {
  return (await tokenStatusFields(path)).tokenStatus;
}

async function readAccountIdPresent(path: string): Promise<boolean> {
  return (await tokenStatusFields(path)).accountIdPresent;
}
