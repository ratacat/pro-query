import { spawn, spawnSync } from "node:child_process";
import { access, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
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

export type BrowserSessionState =
  | "present"
  | "logged_out"
  | "probe_failed"
  | "page_missing"
  | "cdp_unavailable";

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

    const probeStatus = typeof result?.status === "number" ? result.status : 0;
    const isLoggedOutSignal = probeStatus === 200 || probeStatus === 401;
    if (probeStatus !== 0 && !isLoggedOutSignal) {
      return {
        status: "probe_failed",
        cdpBase,
        httpStatus: probeStatus,
        pageOrigin: result?.origin,
        errorCode: "CHATGPT_PROBE_FAILED",
        message: `ChatGPT auth session probe returned HTTP ${probeStatus}.`,
        suggestions: probeFailedSuggestions(probeStatus, cdpBase),
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

function probeFailedSuggestions(status: number, cdpBase: string): string[] {
  if (status === 431) {
    return [
      "HTTP 431 means the request headers were too large; the CDP Chrome profile likely has stale cookie buildup.",
      `Sign out of ChatGPT in the CDP window, sign back in, then run pro-cli auth capture --cdp ${cdpBase} --json.`,
      "If 431 persists, delete ~/.pro-cli/chrome-profile and rerun pro-cli auth command.",
    ];
  }
  if (status >= 500) {
    return [
      `ChatGPT returned HTTP ${status} on the auth probe; the upstream is likely degraded.`,
      "Reload the CDP ChatGPT tab, wait, and rerun pro-cli doctor --json.",
    ];
  }
  return [
    `The CDP ChatGPT auth session probe returned HTTP ${status}; cannot determine login state.`,
    "Reload the CDP ChatGPT tab and rerun pro-cli doctor --json. If the page is on a non-chatgpt URL, navigate back to https://chatgpt.com/.",
  ];
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

export interface ResetProfileOptions {
  home: string;
  port: string;
  noBackup?: boolean;
  noLaunch?: boolean;
  keepBackups?: number;
}

export interface ResetProfileResult {
  profileDir: string;
  killedPids: number[];
  removed: { mode: "backup" | "delete" | "missing"; from: string; to?: string };
  prunedBackups: string[];
  launched: { command: string } | null;
  cdp: string;
  next: { command: string; reason: string };
}

export async function resetAuthProfile(options: ResetProfileOptions): Promise<ResetProfileResult> {
  const profileDir = join(options.home, "chrome-profile");
  if (!profileDir.startsWith(options.home + "/") && profileDir !== options.home) {
    throw new ProError("RESET_PATH_UNSAFE", "Refusing to reset a profile outside the pro-cli home.", {
      exitCode: EXIT.invalidArgs,
      details: { profileDir, home: options.home },
    });
  }

  const killedPids = killChromeForProfile(profileDir);
  if (killedPids.length > 0) {
    await sleepMs(1500);
    for (const pid of killedPids) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  const removed = await removeProfileDir(profileDir, !options.noBackup);
  const keepBackups = Math.max(0, options.keepBackups ?? 5);
  const prunedBackups = await pruneOldBackups(options.home, keepBackups);

  let launched: ResetProfileResult["launched"] = null;
  if (!options.noLaunch) {
    const command = buildOpenChromeCommand(profileDir, options.port);
    const child = spawn("/bin/sh", ["-c", command], { detached: true, stdio: "ignore" });
    child.unref();
    launched = { command };
  }

  const cdp = `http://127.0.0.1:${options.port}`;
  return {
    profileDir,
    killedPids,
    removed,
    prunedBackups,
    launched,
    cdp,
    next: {
      command: `pro-cli auth capture --cdp ${cdp} --json`,
      reason: launched
        ? "Profile reset and Chrome relaunched. Sign in to ChatGPT in the new window, then run the capture command."
        : "Profile reset. Open a new Chrome with pro-cli auth command, sign in, then run the capture command.",
    },
  };
}

function killChromeForProfile(profileDir: string): number[] {
  const ps = spawnSync("ps", ["axo", "pid=,command="], { encoding: "utf8" });
  if (ps.status !== 0) return [];
  const needle = `--user-data-dir=${profileDir}`;
  const pids: number[] = [];
  for (const rawLine of ps.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line.includes(needle)) continue;
    const match = line.match(/^(\d+)\s/);
    if (!match) continue;
    pids.push(Number.parseInt(match[1], 10));
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // process may have exited between ps and kill
    }
  }
  return pids;
}

async function removeProfileDir(
  dir: string,
  backup: boolean,
): Promise<ResetProfileResult["removed"]> {
  try {
    await stat(dir);
  } catch {
    return { mode: "missing", from: dir };
  }
  if (backup) {
    const ts = backupTimestamp();
    let target = `${dir}.backup-${ts}`;
    let suffix = 1;
    while (await pathExists(target)) {
      target = `${dir}.backup-${ts}-${suffix}`;
      suffix += 1;
    }
    await rename(dir, target);
    return { mode: "backup", from: dir, to: target };
  }
  await rm(dir, { recursive: true, force: true });
  return { mode: "delete", from: dir };
}

async function pruneOldBackups(home: string, keep: number): Promise<string[]> {
  const entries = await readdir(home).catch(() => [] as string[]);
  const backups = entries
    .filter((name) => /^chrome-profile\.backup-/.test(name))
    .sort()
    .reverse();
  const toRemove = backups.slice(keep);
  const removed: string[] = [];
  for (const name of toRemove) {
    const full = join(home, name);
    try {
      await rm(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      // ignore individual prune failures
    }
  }
  return removed;
}

function buildOpenChromeCommand(profileDir: string, port: string): string {
  const url = "https://chatgpt.com/";
  if (process.platform === "darwin") {
    return `open -na "Google Chrome" --args --user-data-dir='${profileDir}' --remote-debugging-port=${port} ${url}`;
  }
  if (process.platform === "win32") {
    return `start "" chrome.exe --user-data-dir="${profileDir}" --remote-debugging-port=${port} ${url}`;
  }
  return `google-chrome --user-data-dir='${profileDir}' --remote-debugging-port=${port} ${url}`;
}

function backupTimestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
