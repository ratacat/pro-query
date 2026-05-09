import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  chatGptOrigins,
  cookieSummary,
  isVolatileCookieName,
  loadCookieExport,
  sanitizeCookies,
  toCookieExport,
  toCookieHeader,
  toNetscapeCookieJar,
  type BrowserCookie,
} from "../src/cookies";

describe("cookie sanitization", () => {
  test("drops volatile per-conversation cookies", () => {
    const cookies = sanitizeCookies([
      cookie("__Secure-next-auth.session-token", "chatgpt.com", "session"),
      cookie("conv_key_abc", "chatgpt.com", "temporary"),
    ]);

    expect(cookies.map((stored) => stored.name)).toEqual(["__Secure-next-auth.session-token"]);
  });

  test("does not replay volatile cookies in a Cookie header", () => {
    const header = toCookieHeader([
      cookie("__Secure-next-auth.session-token", "chatgpt.com", "session"),
      cookie("conv_key_abc", "chatgpt.com", "temporary"),
    ]);

    expect(header).toBe("__Secure-next-auth.session-token=session");
  });
});

describe("isVolatileCookieName", () => {
  test("matches the conv_key_ prefix exactly", () => {
    expect(isVolatileCookieName("conv_key_abc")).toBe(true);
    expect(isVolatileCookieName("conv_key_")).toBe(true);
    expect(isVolatileCookieName("conv_key_xyz_123")).toBe(true);
  });

  test("does NOT match cookies that merely contain the substring", () => {
    expect(isVolatileCookieName("not_conv_key_x")).toBe(false);
    expect(isVolatileCookieName("xconv_key_y")).toBe(false);
  });

  test("does NOT match without the trailing underscore", () => {
    // If someone changes prefix to "conv_key" they would over-match.
    expect(isVolatileCookieName("conv_keyabc")).toBe(false);
    expect(isVolatileCookieName("conv_key")).toBe(false);
  });

  test("preserves cookies critical to login and CF challenge state", () => {
    // Regression guard: if someone broadens the volatile list to include any
    // of these, sessions break silently or CF challenges replay on every call.
    expect(isVolatileCookieName("__Secure-next-auth.session-token")).toBe(false);
    expect(isVolatileCookieName("__Secure-next-auth.session-token.0")).toBe(false);
    expect(isVolatileCookieName("__Host-next-auth.csrf-token")).toBe(false);
    expect(isVolatileCookieName("cf_clearance")).toBe(false);
    expect(isVolatileCookieName("__cf_bm")).toBe(false);
    expect(isVolatileCookieName("_cfuvid")).toBe(false);
    expect(isVolatileCookieName("oai-did")).toBe(false);
    expect(isVolatileCookieName("oai-sc")).toBe(false);
  });

  test("is case sensitive (matches lowercase prefix only)", () => {
    expect(isVolatileCookieName("CONV_KEY_abc")).toBe(false);
    expect(isVolatileCookieName("Conv_Key_abc")).toBe(false);
  });
});

describe("sanitizeCookies invariants", () => {
  test("dedupes by name|domain|path triple, last write wins", () => {
    const result = sanitizeCookies([
      cookie("a", "chatgpt.com", "v1"),
      cookie("a", "chatgpt.com", "v2"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("v2");
  });

  test("keeps separate entries for the same name on different paths", () => {
    const result = sanitizeCookies([
      { name: "a", value: "root", domain: "chatgpt.com", path: "/", secure: true },
      { name: "a", value: "api", domain: "chatgpt.com", path: "/api", secure: true },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.path).sort()).toEqual(["/", "/api"]);
  });

  test("keeps separate entries for the same name on different domains", () => {
    const result = sanitizeCookies([
      cookie("a", "chatgpt.com", "v1"),
      cookie("a", "openai.com", "v2"),
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.domain).sort()).toEqual(["chatgpt.com", "openai.com"]);
  });

  test("strips a leading dot from the cookie domain", () => {
    const result = sanitizeCookies([
      { name: "a", value: "v", domain: ".chatgpt.com", path: "/", secure: true },
    ]);
    expect(result[0].domain).toBe("chatgpt.com");
  });

  test("dedupes a leading-dot domain against a non-dot domain", () => {
    // After strip, both keys collapse; otherwise the same logical cookie
    // could be sent twice with different attributes.
    const result = sanitizeCookies([
      { name: "a", value: "first", domain: ".chatgpt.com", path: "/", secure: true },
      { name: "a", value: "second", domain: "chatgpt.com", path: "/", secure: true },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("second");
  });

  test("defaults missing domain to chatgpt.com", () => {
    const result = sanitizeCookies([
      { name: "a", value: "v", domain: "", path: "/", secure: true },
    ]);
    expect(result[0].domain).toBe("chatgpt.com");
  });

  test("defaults missing path to /", () => {
    const result = sanitizeCookies([
      { name: "a", value: "v", domain: "chatgpt.com", path: "", secure: true },
    ]);
    expect(result[0].path).toBe("/");
  });

  test("filters cookies with empty name", () => {
    const result = sanitizeCookies([
      cookie("", "chatgpt.com", "v"),
      cookie("a", "chatgpt.com", "v"),
    ]);
    expect(result.map((c) => c.name)).toEqual(["a"]);
  });

  test("filters cookies with undefined value", () => {
    const result = sanitizeCookies([
      { name: "a", value: undefined as unknown as string, domain: "chatgpt.com", path: "/", secure: true },
      cookie("b", "chatgpt.com", "v"),
    ]);
    expect(result.map((c) => c.name)).toEqual(["b"]);
  });

  test("preserves an explicit empty-string value (auth flows rely on this)", () => {
    // value === undefined is filtered; value === "" must survive.
    const result = sanitizeCookies([{ name: "a", value: "", domain: "chatgpt.com", path: "/", secure: true }]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("");
  });

  test("returns cookies sorted alphabetically by name", () => {
    const result = sanitizeCookies([
      cookie("zebra", "chatgpt.com", "z"),
      cookie("alpha", "chatgpt.com", "a"),
      cookie("mango", "chatgpt.com", "m"),
    ]);
    expect(result.map((c) => c.name)).toEqual(["alpha", "mango", "zebra"]);
  });

  test("preserves all optional fields when present", () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const result = sanitizeCookies([
      {
        name: "a",
        value: "v",
        domain: "chatgpt.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        expires,
      },
    ]);
    expect(result[0]).toEqual({
      name: "a",
      value: "v",
      domain: "chatgpt.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      expires,
    });
  });

  test("preserves explicit secure=false", () => {
    // Important: do not silently flip secure to true (would break some local flows).
    const result = sanitizeCookies([
      { name: "a", value: "v", domain: "chatgpt.com", path: "/", secure: false },
    ]);
    expect(result[0].secure).toBe(false);
  });

  test("omits absent optional fields rather than emitting undefined", () => {
    // Stored JSON should not have explicit `undefined` keys leaking through.
    const result = sanitizeCookies([
      { name: "a", value: "v", domain: "chatgpt.com", path: "/" } as BrowserCookie,
    ]);
    const keys = Object.keys(result[0]).sort();
    expect(keys).toEqual(["domain", "name", "path", "value"]);
  });
});

describe("toCookieHeader", () => {
  test("joins multiple cookies with semicolon-space", () => {
    const header = toCookieHeader([
      cookie("a", "chatgpt.com", "v1"),
      cookie("b", "chatgpt.com", "v2"),
    ]);
    expect(header).toBe("a=v1; b=v2");
  });

  test("filters expired cookies (regression: stale tokens must NOT replay)", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 3600;
    const header = toCookieHeader([
      { name: "old", value: "v", domain: "chatgpt.com", path: "/", secure: true, expires: past },
      { name: "fresh", value: "v", domain: "chatgpt.com", path: "/", secure: true, expires: future },
    ]);
    expect(header).toBe("fresh=v");
  });

  test("keeps session cookies that have no expires", () => {
    const header = toCookieHeader([cookie("session", "chatgpt.com", "v")]);
    expect(header).toBe("session=v");
  });

  test("returns empty string when given no cookies", () => {
    expect(toCookieHeader([])).toBe("");
  });

  test("returns empty string when every cookie is expired", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const header = toCookieHeader([
      { name: "a", value: "v", domain: "chatgpt.com", path: "/", expires: past },
    ]);
    expect(header).toBe("");
  });

  test("never replays volatile cookies even when not expired", () => {
    const header = toCookieHeader([
      cookie("__Secure-next-auth.session-token", "chatgpt.com", "session"),
      cookie("conv_key_xyz", "chatgpt.com", "vol"),
    ]);
    expect(header).not.toContain("conv_key_");
    expect(header).toContain("session-token=session");
  });
});

describe("cookieSummary", () => {
  test("counts cookies (including duplicates), unique domains and names", () => {
    const summary = cookieSummary([
      cookie("a", "chatgpt.com", "v"),
      cookie("a", "chatgpt.com", "v"),
      cookie("b", "openai.com", "v"),
    ]);
    expect(summary.count).toBe(3);
    expect(summary.domains).toEqual(["chatgpt.com", "openai.com"]);
    expect(summary.names).toEqual(["a", "b"]);
  });

  test("strips leading dots from the domain set", () => {
    const summary = cookieSummary([
      cookie("a", ".chatgpt.com", "v"),
      cookie("b", "chatgpt.com", "v"),
    ]);
    expect(summary.domains).toEqual(["chatgpt.com"]);
  });

  test("counts expired cookies by current wall-clock", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 3600;
    const summary = cookieSummary([
      { name: "old", value: "v", domain: "chatgpt.com", path: "/", expires: past },
      { name: "fresh", value: "v", domain: "chatgpt.com", path: "/", expires: future },
      { name: "session", value: "v", domain: "chatgpt.com", path: "/" },
    ]);
    expect(summary.expired).toBe(1);
    expect(summary.count).toBe(3);
  });

  test("returns empty arrays and zero counts for an empty input", () => {
    const summary = cookieSummary([]);
    expect(summary.count).toBe(0);
    expect(summary.expired).toBe(0);
    expect(summary.domains).toEqual([]);
    expect(summary.names).toEqual([]);
  });
});

describe("toCookieExport", () => {
  test("wraps cookies in v1 envelope and runs sanitization", () => {
    const exportObj = toCookieExport([
      cookie("a", "chatgpt.com", "v"),
      cookie("conv_key_x", "chatgpt.com", "drop"),
    ]);
    expect(exportObj.version).toBe(1);
    expect(exportObj.source).toBe("pro-cli-cdp");
    expect(exportObj.cookies.map((c) => c.name)).toEqual(["a"]);
    expect(exportObj.targetUrl).toBe("https://chatgpt.com/");
    expect(exportObj.origins).toContain("https://chatgpt.com/");
    expect(exportObj.origins).toContain("https://auth.openai.com/");
    expect(typeof exportObj.generatedAt).toBe("string");
    expect(() => new Date(exportObj.generatedAt).toISOString()).not.toThrow();
  });
});

describe("toNetscapeCookieJar", () => {
  test("emits Netscape format with TAB-separated fields", () => {
    const jar = toNetscapeCookieJar([
      { name: "a", value: "v", domain: ".chatgpt.com", path: "/", secure: true, expires: 1234567890 },
    ]);
    const entryLines = jar.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(entryLines).toHaveLength(1);
    const fields = entryLines[0].split("\t");
    expect(fields).toHaveLength(7);
    expect(fields[0]).toBe("chatgpt.com"); // domain stripped
    expect(fields[1]).toBe("TRUE"); // includeSubdomains because of leading dot
    expect(fields[2]).toBe("/");
    expect(fields[3]).toBe("TRUE"); // secure
    expect(fields[4]).toBe("1234567890");
    expect(fields[5]).toBe("a");
    expect(fields[6]).toBe("v");
  });

  test("includeSubdomains=FALSE when the cookie has no leading dot", () => {
    const jar = toNetscapeCookieJar([
      { name: "a", value: "v", domain: "chatgpt.com", path: "/", secure: false },
    ]);
    const fields = jar.split("\n").find((l) => l && !l.startsWith("#"))!.split("\t");
    expect(fields[1]).toBe("FALSE");
    expect(fields[3]).toBe("FALSE");
  });

  test("emits 0 for missing expires (session cookie)", () => {
    const jar = toNetscapeCookieJar([cookie("a", "chatgpt.com", "v")]);
    const fields = jar.split("\n").find((l) => l && !l.startsWith("#"))!.split("\t");
    expect(fields[4]).toBe("0");
  });

  test("starts with header comments and ends with newline", () => {
    const jar = toNetscapeCookieJar([cookie("a", "chatgpt.com", "v")]);
    expect(jar.startsWith("# Netscape HTTP Cookie File\n")).toBe(true);
    expect(jar.endsWith("\n")).toBe(true);
  });

  test("does not emit volatile cookies", () => {
    const jar = toNetscapeCookieJar([
      cookie("a", "chatgpt.com", "keep"),
      cookie("conv_key_x", "chatgpt.com", "drop"),
    ]);
    expect(jar).toContain("\ta\t");
    expect(jar).not.toContain("conv_key_");
  });
});

describe("loadCookieExport", () => {
  test("upgrades a bare cookies array to a v1 envelope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cookies-export-"));
    const path = join(dir, "cookies.json");
    try {
      await writeFile(path, JSON.stringify([cookie("a", "chatgpt.com", "v")]));
      const result = await loadCookieExport(path);
      expect(result.version).toBe(1);
      expect(result.source).toBe("pro-cli-cdp");
      expect(result.cookies.map((c) => c.name)).toEqual(["a"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("upgrades a {cookies} object lacking a version field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cookies-export-"));
    const path = join(dir, "cookies.json");
    try {
      await writeFile(path, JSON.stringify({ cookies: [cookie("a", "chatgpt.com", "v")] }));
      const result = await loadCookieExport(path);
      expect(result.version).toBe(1);
      expect(result.cookies.map((c) => c.name)).toEqual(["a"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns a v1 envelope verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cookies-export-"));
    const path = join(dir, "cookies.json");
    try {
      const obj = {
        version: 1 as const,
        generatedAt: "2026-01-01T00:00:00.000Z",
        source: "pro-cli-cdp" as const,
        targetUrl: "https://chatgpt.com/",
        origins: ["https://chatgpt.com/"],
        cookies: [cookie("a", "chatgpt.com", "v")],
      };
      await writeFile(path, JSON.stringify(obj));
      const result = await loadCookieExport(path);
      expect(result).toEqual(obj);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("chatGptOrigins", () => {
  test("returns the canonical origin list", () => {
    const origins = chatGptOrigins();
    expect(origins).toEqual([
      "https://chatgpt.com/",
      "https://auth.openai.com/",
      "https://openai.com/",
      "https://sentinel.openai.com/",
      "https://ws.chatgpt.com/",
    ]);
  });

  test("returns a fresh array — callers cannot mutate the canonical list", () => {
    // Regression guard: if someone returned the literal const array directly,
    // callers could push into it and corrupt every later auth capture.
    const a = chatGptOrigins();
    const b = chatGptOrigins();
    a.push("https://attacker.example/");
    expect(b).not.toContain("https://attacker.example/");
  });
});

function cookie(name: string, domain: string, value: string): BrowserCookie {
  return { name, value, domain, path: "/", secure: true };
}
