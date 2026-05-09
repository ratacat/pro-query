import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  isTokenFresh,
  loadSessionToken,
  toSessionTokenExport,
  type SessionTokenExport,
} from "../src/session-token";

function jwt(payload: Record<string, unknown>): string {
  return [
    "header",
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

describe("toSessionTokenExport", () => {
  test("extracts accountId from the openai auth claim", () => {
    const token = jwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_xyz" },
    });
    const exported = toSessionTokenExport(token);
    expect(exported.accountId).toBe("acct_xyz");
  });

  test("derives expiresAt as ISO string from the exp claim", () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 3600;
    const token = jwt({
      exp: expSeconds,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_xyz" },
    });
    const exported = toSessionTokenExport(token);
    expect(exported.expiresAt).toBe(new Date(expSeconds * 1000).toISOString());
  });

  test("omits accountId when no chatgpt_account_id claim is present", () => {
    const token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const exported = toSessionTokenExport(token);
    expect("accountId" in exported).toBe(false);
  });

  test("omits expiresAt when no exp claim is present", () => {
    const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_xyz" } });
    const exported = toSessionTokenExport(token);
    expect("expiresAt" in exported).toBe(false);
  });

  test("ignores claims with the wrong shape (e.g. numeric account id)", () => {
    const token = jwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: 12345 },
    });
    const exported = toSessionTokenExport(token);
    expect("accountId" in exported).toBe(false);
  });

  test("survives a malformed JWT (returns export with no claims)", () => {
    // Regression guard: a corrupted JWT must NOT throw — the auth capture
    // flow should still write a valid SessionTokenExport so the user can
    // recover.
    const exported = toSessionTokenExport("not.a.real-jwt");
    expect(exported.accessToken).toBe("not.a.real-jwt");
    expect(exported.version).toBe(1);
    expect(exported.source).toBe("pro-cli-cdp-page");
    expect("accountId" in exported).toBe(false);
    expect("expiresAt" in exported).toBe(false);
  });

  test("survives a JWT with non-base64 payload", () => {
    const exported = toSessionTokenExport("a.@@@.c");
    expect(exported.accessToken).toBe("a.@@@.c");
    expect("accountId" in exported).toBe(false);
  });

  test("decodes base64url payloads with -/_ characters (RFC 4648 §5)", () => {
    // base64url uses - and _ instead of + and /. JWT spec requires this.
    // Verify our decoder handles it.
    const standardB64 = Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_b64url" },
      }),
    ).toString("base64");
    // Convert to base64url manually.
    const urlSafe = standardB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const token = ["header", urlSafe, "sig"].join(".");
    const exported = toSessionTokenExport(token);
    expect(exported.accountId).toBe("acct_b64url");
  });
});

describe("isTokenFresh", () => {
  test("returns true for tokens with no expiresAt (treat as fresh)", () => {
    const token: SessionTokenExport = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "pro-cli-cdp-page",
      accessToken: "x",
    };
    expect(isTokenFresh(token)).toBe(true);
  });

  test("returns true for a token expiring well in the future", () => {
    const token: SessionTokenExport = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "pro-cli-cdp-page",
      accessToken: "x",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    expect(isTokenFresh(token)).toBe(true);
  });

  test("returns false for a token already expired", () => {
    const token: SessionTokenExport = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "pro-cli-cdp-page",
      accessToken: "x",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    expect(isTokenFresh(token)).toBe(false);
  });

  test("returns false for a token within the default skew window", () => {
    // Default skewMs is 60s. A token expiring in 30s should be considered
    // stale so callers refresh BEFORE it expires.
    const token: SessionTokenExport = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "pro-cli-cdp-page",
      accessToken: "x",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    expect(isTokenFresh(token)).toBe(false);
  });

  test("respects an explicit skew override", () => {
    // With skewMs=0, a token expiring in 30s is fresh.
    const token: SessionTokenExport = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "pro-cli-cdp-page",
      accessToken: "x",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    expect(isTokenFresh(token, 0)).toBe(true);
    // With a giant skew, even a fresh-looking token is stale.
    expect(isTokenFresh(token, 24 * 60 * 60 * 1000)).toBe(false);
  });
});

describe("loadSessionToken", () => {
  test("parses a JSON token file from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-token-load-"));
    const path = join(dir, "token.json");
    try {
      const original = {
        version: 1 as const,
        generatedAt: "2026-05-01T00:00:00Z",
        source: "pro-cli-cdp-page" as const,
        accessToken: "eyJ.body.sig",
        accountId: "acct_xyz",
        expiresAt: "2026-06-01T00:00:00Z",
      };
      await writeFile(path, JSON.stringify(original));
      const loaded = await loadSessionToken(path);
      expect(loaded).toEqual(original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects when the file does not exist", async () => {
    await expect(loadSessionToken("/tmp/pro-cli-no-such-token.json")).rejects.toThrow();
  });

  test("rejects when the file content is not valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-token-bad-"));
    const path = join(dir, "token.json");
    try {
      await writeFile(path, "not json {");
      await expect(loadSessionToken(path)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
