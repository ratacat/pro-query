import { readFile } from "node:fs/promises";

export interface SessionTokenExport {
  version: 1;
  generatedAt: string;
  source: "pro-cli-cdp-page";
  accessToken: string;
  accountId?: string;
  expiresAt?: string;
}

export function toSessionTokenExport(accessToken: string): SessionTokenExport {
  const expiresMs = jwtExpiryMs(accessToken);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "pro-cli-cdp-page",
    accessToken,
    ...(accountIdFromToken(accessToken) ? { accountId: accountIdFromToken(accessToken) } : {}),
    ...(expiresMs !== undefined ? { expiresAt: new Date(expiresMs).toISOString() } : {}),
  };
}

export async function loadSessionToken(path: string): Promise<SessionTokenExport> {
  return JSON.parse(await readFile(path, "utf8")) as SessionTokenExport;
}

export function isTokenFresh(token: SessionTokenExport, skewMs = 60_000): boolean {
  if (!token.expiresAt) return true;
  return Date.now() < Date.parse(token.expiresAt) - skewMs;
}

function accountIdFromToken(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

function jwtExpiryMs(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  return typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
