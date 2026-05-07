import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

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

export function resolveHome(env: Record<string, string | undefined>): string {
  return expandPath(env.PRO_HOME ?? "~/.pro");
}

export function resolvePaths(
  env: Record<string, string | undefined>,
  config: ProConfig = {},
): RuntimePaths {
  const home = resolveHome(env);
  return {
    home,
    configPath: join(home, "config.json"),
    cookieJsonPath:
      env.CHATGPT_COOKIE_JSON ?? config.cookieJsonPath ?? join(home, "cookies", "chatgpt.json"),
    cookieJarPath:
      env.CHATGPT_COOKIE_JAR ?? config.cookieJarPath ?? join(home, "cookies", "chatgpt.txt"),
    sessionTokenPath:
      env.CHATGPT_SESSION_TOKEN_JSON ??
      config.sessionTokenPath ??
      join(home, "tokens", "chatgpt-session.json"),
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function saveConfig(
  env: Record<string, string | undefined>,
  config: ProConfig,
): Promise<void> {
  const home = resolveHome(env);
  await ensurePrivateDir(home);
  await writePrivateFile(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

export function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}
