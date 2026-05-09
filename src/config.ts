import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { EXIT, ProError } from "./errors";

export interface ProConfig {
  cookieJsonPath?: string;
  cookieJarPath?: string;
  sessionTokenPath?: string;
  defaultModel?: string;
  defaultReasoning?: string;
}

export interface RuntimePaths {
  home: string;
  configPath: string;
  cookieJsonPath: string;
  cookieJarPath: string;
  sessionTokenPath: string;
  dbPath: string;
}

const DEFAULT_HOME = "~/.pro-cli";
const LEGACY_HOME = "~/.pro";

export function resolveHome(env: Record<string, string | undefined>): string {
  return expandPath(env.PRO_CLI_HOME || DEFAULT_HOME);
}

export async function migrateLegacyDefaultHome(
  env: Record<string, string | undefined>,
  homedirOverride?: string,
): Promise<void> {
  if (env.PRO_CLI_HOME) return;
  const baseHome = homedirOverride ?? homedir();
  const nextHome = join(baseHome, ".pro-cli");
  const legacyHome = join(baseHome, ".pro");
  if (await pathExists(nextHome)) {
    await rewriteMigratedConfigPaths(nextHome, legacyHome);
    return;
  }
  if (!(await pathExists(legacyHome))) return;
  try {
    await rename(legacyHome, nextHome);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EXDEV") return;
    throw error;
  }
  await chmod(nextHome, 0o700).catch(() => undefined);
  await rewriteMigratedConfigPaths(nextHome, legacyHome);
}

export function resolvePaths(
  env: Record<string, string | undefined>,
  config: ProConfig = {},
): RuntimePaths {
  const home = resolveHome(env);
  const cookieJsonPath = env.CHATGPT_COOKIE_JSON || config.cookieJsonPath || join(home, "cookies", "chatgpt.json");
  const cookieJarPath = env.CHATGPT_COOKIE_JAR || config.cookieJarPath || join(home, "cookies", "chatgpt.txt");
  const sessionTokenPath =
    env.CHATGPT_SESSION_TOKEN_JSON ||
    config.sessionTokenPath ||
    join(home, "tokens", "chatgpt-session.json");
  return {
    home,
    configPath: join(home, "config.json"),
    cookieJsonPath: expandPath(cookieJsonPath),
    cookieJarPath: expandPath(cookieJarPath),
    sessionTokenPath: expandPath(sessionTokenPath),
    dbPath: join(home, "jobs.sqlite"),
  };
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

export async function writePrivateFile(path: string, content: string): Promise<void> {
  await ensurePrivateDir(dirname(path));
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function loadConfig(env: Record<string, string | undefined>): Promise<ProConfig> {
  const home = resolveHome(env);
  const configPath = join(home, "config.json");
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as ProConfig;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    if (isPermissionError(error)) throw configAccessError("CONFIG_UNREADABLE", "read", configPath, error);
    throw error;
  }
}

export async function saveConfig(
  env: Record<string, string | undefined>,
  config: ProConfig,
): Promise<void> {
  const home = resolveHome(env);
  const configPath = join(home, "config.json");
  try {
    await ensurePrivateDir(home);
    await writePrivateFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  } catch (error) {
    if (isPermissionError(error)) throw configAccessError("CONFIG_UNWRITABLE", "write", configPath, error);
    throw error;
  }
}

export function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function rewriteMigratedConfigPaths(nextHome: string, legacyHome: string): Promise<void> {
  const configPath = join(nextHome, "config.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return;
  }

  const config = JSON.parse(raw) as ProConfig;
  const rewritten: ProConfig = {
    ...config,
    cookieJsonPath: rewriteHomePrefix(config.cookieJsonPath, legacyHome, nextHome),
    cookieJarPath: rewriteHomePrefix(config.cookieJarPath, legacyHome, nextHome),
    sessionTokenPath: rewriteHomePrefix(config.sessionTokenPath, legacyHome, nextHome),
  };
  await writePrivateFile(configPath, `${JSON.stringify(rewritten, null, 2)}\n`);
}

function rewriteHomePrefix(path: string | undefined, fromHome: string, toHome: string): string | undefined {
  if (!path) return undefined;
  if (path === fromHome) return toHome;
  const prefix = `${fromHome}/`;
  return path.startsWith(prefix) ? join(toHome, path.slice(prefix.length)) : path;
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

function configAccessError(
  code: "CONFIG_UNREADABLE" | "CONFIG_UNWRITABLE",
  action: "read" | "write",
  configPath: string,
  error: unknown,
): ProError {
  const errno = (error as NodeJS.ErrnoException).code;
  const syscall = (error as NodeJS.ErrnoException).syscall;
  return new ProError(code, `Cannot ${action} pro-cli config at ${configPath}.`, {
    exitCode: EXIT.auth,
    suggestions: [
      `Fix local ownership/permissions for ${configPath}, or set PRO_CLI_HOME to a writable pro-cli home.`,
      "After fixing storage, run pro-cli doctor --json. Do not send probe or smoke-test queries; ask/job calls spend Pro quota.",
    ],
    details: {
      configPath,
      ...(errno ? { errno } : {}),
      ...(syscall ? { syscall } : {}),
    },
    cause: error,
  });
}
