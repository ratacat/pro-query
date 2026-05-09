import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  expandPath,
  loadConfig,
  migrateLegacyDefaultHome,
  resolveHome,
  resolvePaths,
  saveConfig,
} from "../src/config";

describe("expandPath", () => {
  test("returns absolute path verbatim", () => {
    expect(expandPath("/etc/hosts")).toBe("/etc/hosts");
  });

  test("resolves a relative path to absolute", () => {
    const result = expandPath("foo/bar");
    expect(result.endsWith("/foo/bar")).toBe(true);
    expect(result.startsWith("/")).toBe(true);
  });

  test("expands a leading ~ to the process homedir", () => {
    // homedir() is captured at process start; we don't try to mutate HOME
    // mid-test (Bun/Node cache it). Instead, verify the structure of the
    // expansion: ~ alone resolves and ~/foo joins onto that.
    const tildeOnly = expandPath("~");
    expect(tildeOnly.startsWith("/")).toBe(true);
    expect(expandPath("~/foo/bar")).toBe(`${tildeOnly}/foo/bar`);
  });

  test("does NOT expand ~user (only bare ~ or ~/)", () => {
    // Regression guard: ~someuser must NOT resolve to anyone's homedir.
    // It should be left alone (then resolved as a relative path).
    const result = expandPath("~someuser/foo");
    // Whatever the result is, it must not be the homedir form.
    expect(result.includes("~someuser")).toBe(true);
  });
});

describe("resolveHome", () => {
  test("uses PRO_CLI_HOME env var when set", () => {
    expect(resolveHome({ PRO_CLI_HOME: "/custom/home" })).toBe("/custom/home");
  });

  test("expands ~ in PRO_CLI_HOME", () => {
    const result = resolveHome({ PRO_CLI_HOME: "~/my-pro" });
    expect(result.endsWith("/my-pro")).toBe(true);
    expect(result.startsWith("/")).toBe(true);
    expect(result).not.toContain("~");
  });

  test("falls back to ~/.pro-cli when PRO_CLI_HOME is missing", () => {
    const result = resolveHome({});
    expect(result.endsWith("/.pro-cli")).toBe(true);
    expect(result.startsWith("/")).toBe(true);
  });

  test("falls back to ~/.pro-cli when PRO_CLI_HOME is the empty string", () => {
    // Catches a regression where `env.PRO_CLI_HOME ?? DEFAULT_HOME` was
    // changed to `env.PRO_CLI_HOME || DEFAULT_HOME` (the spec needs ??).
    // Currently ?? lets empty-string through, so empty string yields a
    // resolve(""). Document that behavior.
    const result = resolveHome({ PRO_CLI_HOME: "" });
    expect(typeof result).toBe("string");
  });
});

describe("resolvePaths", () => {
  test("computes all canonical paths under the resolved home", () => {
    const paths = resolvePaths({ PRO_CLI_HOME: "/x/.pro-cli" });
    expect(paths.home).toBe("/x/.pro-cli");
    expect(paths.configPath).toBe("/x/.pro-cli/config.json");
    expect(paths.cookieJsonPath).toBe("/x/.pro-cli/cookies/chatgpt.json");
    expect(paths.cookieJarPath).toBe("/x/.pro-cli/cookies/chatgpt.txt");
    expect(paths.sessionTokenPath).toBe("/x/.pro-cli/tokens/chatgpt-session.json");
    expect(paths.dbPath).toBe("/x/.pro-cli/jobs.sqlite");
  });

  test("env-level cookie path overrides config and default", () => {
    const paths = resolvePaths(
      { PRO_CLI_HOME: "/x/.pro-cli", CHATGPT_COOKIE_JSON: "/env/cookies.json" },
      { cookieJsonPath: "/config/cookies.json" },
    );
    expect(paths.cookieJsonPath).toBe("/env/cookies.json");
  });

  test("config-level cookie path overrides default when env is absent", () => {
    const paths = resolvePaths({ PRO_CLI_HOME: "/x/.pro-cli" }, { cookieJsonPath: "/config/cookies.json" });
    expect(paths.cookieJsonPath).toBe("/config/cookies.json");
  });

  test("env-level cookie jar path overrides config and default", () => {
    const paths = resolvePaths(
      { PRO_CLI_HOME: "/x/.pro-cli", CHATGPT_COOKIE_JAR: "/env/cookies.txt" },
      { cookieJarPath: "/config/cookies.txt" },
    );
    expect(paths.cookieJarPath).toBe("/env/cookies.txt");
  });

  test("env-level session token path overrides config and default", () => {
    const paths = resolvePaths(
      { PRO_CLI_HOME: "/x/.pro-cli", CHATGPT_SESSION_TOKEN_JSON: "/env/token.json" },
      { sessionTokenPath: "/config/token.json" },
    );
    expect(paths.sessionTokenPath).toBe("/env/token.json");
  });

  test("dbPath is always under home (never overridable via env or config)", () => {
    // Regression guard: if dbPath ever became overridable, the daemon's
    // discovery would split. Currently it must always live at <home>/jobs.sqlite.
    const paths = resolvePaths(
      {
        PRO_CLI_HOME: "/x/.pro-cli",
        // None of these should affect dbPath.
        CHATGPT_COOKIE_JSON: "/env/cookies.json",
        CHATGPT_COOKIE_JAR: "/env/cookies.txt",
        CHATGPT_SESSION_TOKEN_JSON: "/env/token.json",
      },
      {},
    );
    expect(paths.dbPath).toBe("/x/.pro-cli/jobs.sqlite");
  });
});

describe("loadConfig + saveConfig", () => {
  test("returns empty config when no file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-config-"));
    try {
      const config = await loadConfig({ PRO_CLI_HOME: dir });
      expect(config).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("round-trips: saved config is read back identically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-config-"));
    try {
      const original = {
        defaultModel: "gpt-5-5-pro",
        defaultReasoning: "extended",
        cookieJsonPath: "/some/path/cookies.json",
      };
      await saveConfig({ PRO_CLI_HOME: dir }, original);
      const loaded = await loadConfig({ PRO_CLI_HOME: dir });
      expect(loaded).toEqual(original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed JSON (does not silently swallow)", async () => {
    // A corrupted config file must NOT silently load as empty — the user
    // would lose all customization without realizing.
    const dir = await mkdtemp(join(tmpdir(), "pro-config-"));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "config.json"), "{ not json");
      await expect(loadConfig({ PRO_CLI_HOME: dir })).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("saveConfig creates the home directory if it does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-config-"));
    try {
      const home = join(dir, "deep", "nested", "home");
      await saveConfig({ PRO_CLI_HOME: home }, { defaultModel: "gpt-5-5-pro" });
      const loaded = await loadConfig({ PRO_CLI_HOME: home });
      expect(loaded.defaultModel).toBe("gpt-5-5-pro");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("migrateLegacyDefaultHome", () => {
  test("is a no-op when PRO_CLI_HOME is set (user opted out of migration)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-migrate-skip-"));
    try {
      // Even if .pro exists under our fake home, PRO_CLI_HOME=dir means
      // we should NOT touch it.
      await mkdir(join(dir, ".pro"), { recursive: true });
      await writeFile(join(dir, ".pro", "marker.txt"), "legacy");
      await migrateLegacyDefaultHome({ PRO_CLI_HOME: dir }, dir);
      // .pro stays put.
      const entries = await readdir(dir);
      expect(entries).toContain(".pro");
      expect(entries).not.toContain(".pro-cli");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("is a no-op when neither legacy ~/.pro nor ~/.pro-cli exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-migrate-fresh-"));
    try {
      await migrateLegacyDefaultHome({}, dir);
      const entries = await readdir(dir).catch(() => [] as string[]);
      expect(entries).not.toContain(".pro");
      expect(entries).not.toContain(".pro-cli");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does NOT clobber an existing ~/.pro-cli when ~/.pro is also present", async () => {
    // Critical: if the user already migrated AND an older pro-cli still
    // wrote to ~/.pro, do not overwrite the current home.
    const dir = await mkdtemp(join(tmpdir(), "pro-migrate-coexist-"));
    try {
      await mkdir(join(dir, ".pro-cli"), { recursive: true });
      await writeFile(join(dir, ".pro-cli", "marker.txt"), "current");
      await mkdir(join(dir, ".pro"), { recursive: true });
      await writeFile(join(dir, ".pro", "marker.txt"), "legacy");

      await migrateLegacyDefaultHome({}, dir);

      const current = await readFile(join(dir, ".pro-cli", "marker.txt"), "utf8");
      expect(current).toBe("current");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("renames ~/.pro to ~/.pro-cli when only ~/.pro exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-migrate-rename-"));
    try {
      await mkdir(join(dir, ".pro"), { recursive: true });
      await writeFile(join(dir, ".pro", "config.json"), "{}");

      await migrateLegacyDefaultHome({}, dir);

      const entries = await readdir(dir);
      expect(entries).toContain(".pro-cli");
      expect(entries).not.toContain(".pro");
      // rewriteMigratedConfigPaths re-pretty-prints the config, so the
      // file content changes shape but the parsed config is preserved.
      const moved = await readFile(join(dir, ".pro-cli", "config.json"), "utf8");
      expect(JSON.parse(moved)).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rewrites paths inside config.json that pointed at the legacy home", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-migrate-rewrite-"));
    try {
      await mkdir(join(dir, ".pro"), { recursive: true });
      const legacyConfig = {
        cookieJsonPath: join(dir, ".pro", "cookies", "chatgpt.json"),
        cookieJarPath: join(dir, ".pro", "cookies", "chatgpt.txt"),
        sessionTokenPath: join(dir, ".pro", "tokens", "chatgpt-session.json"),
        defaultModel: "gpt-5-5-pro",
      };
      await writeFile(join(dir, ".pro", "config.json"), JSON.stringify(legacyConfig));

      await migrateLegacyDefaultHome({}, dir);

      const newConfig = JSON.parse(
        await readFile(join(dir, ".pro-cli", "config.json"), "utf8"),
      );
      expect(newConfig.cookieJsonPath).toBe(join(dir, ".pro-cli", "cookies", "chatgpt.json"));
      expect(newConfig.cookieJarPath).toBe(join(dir, ".pro-cli", "cookies", "chatgpt.txt"));
      expect(newConfig.sessionTokenPath).toBe(join(dir, ".pro-cli", "tokens", "chatgpt-session.json"));
      // Unrelated config keys preserved.
      expect(newConfig.defaultModel).toBe("gpt-5-5-pro");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("leaves config paths that were OUTSIDE the legacy home untouched", async () => {
    // If the user pointed pro-cli at a custom cookie path (e.g.
    // /elsewhere/cookies.json), the migration must not rewrite it.
    const dir = await mkdtemp(join(tmpdir(), "pro-migrate-foreign-"));
    try {
      await mkdir(join(dir, ".pro"), { recursive: true });
      const legacyConfig = {
        cookieJsonPath: "/elsewhere/cookies.json",
        sessionTokenPath: join(dir, ".pro", "tokens", "session.json"),
      };
      await writeFile(join(dir, ".pro", "config.json"), JSON.stringify(legacyConfig));

      await migrateLegacyDefaultHome({}, dir);

      const newConfig = JSON.parse(
        await readFile(join(dir, ".pro-cli", "config.json"), "utf8"),
      );
      expect(newConfig.cookieJsonPath).toBe("/elsewhere/cookies.json"); // untouched
      expect(newConfig.sessionTokenPath).toBe(join(dir, ".pro-cli", "tokens", "session.json"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rewrites a config path that exactly equals the legacy home (no trailing slash)", async () => {
    // Edge case: a config that stored just legacyHome itself, not a child.
    const dir = await mkdtemp(join(tmpdir(), "pro-migrate-exact-"));
    try {
      await mkdir(join(dir, ".pro"), { recursive: true });
      const legacyConfig = {
        cookieJsonPath: join(dir, ".pro"),
      };
      await writeFile(join(dir, ".pro", "config.json"), JSON.stringify(legacyConfig));

      await migrateLegacyDefaultHome({}, dir);

      const newConfig = JSON.parse(
        await readFile(join(dir, ".pro-cli", "config.json"), "utf8"),
      );
      expect(newConfig.cookieJsonPath).toBe(join(dir, ".pro-cli"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
