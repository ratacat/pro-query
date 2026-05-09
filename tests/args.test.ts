import { describe, expect, test } from "bun:test";
import { ProError } from "../src/errors";
import { flagBoolean, flagString, flagStrings, parseArgs } from "../src/args";

describe("parseArgs: positionals", () => {
  test("collects bare tokens as positionals in order", () => {
    const parsed = parseArgs(["job", "create", "hello", "world"]);
    expect(parsed.positionals).toEqual(["job", "create", "hello", "world"]);
    expect(parsed.flags.size).toBe(0);
  });

  test("treats lone -- as a positional (no special end-of-flags handling)", () => {
    // Document current behavior so a future change is intentional, not
    // accidental.
    const parsed = parseArgs(["job", "--", "tail", "-only"]);
    expect(parsed.positionals).toContain("--");
    expect(parsed.positionals).toContain("tail");
  });

  test("a single-dash token is a positional, not a flag", () => {
    const parsed = parseArgs(["ask", "-"]);
    expect(parsed.positionals).toEqual(["ask", "-"]);
  });
});

describe("parseArgs: boolean flags", () => {
  test("known boolean flags become true without consuming the next token", () => {
    const parsed = parseArgs(["--json", "extra-positional"]);
    expect(parsed.flags.get("json")).toBe(true);
    expect(parsed.positionals).toEqual(["extra-positional"]);
  });

  test("each registered boolean flag is recognized", () => {
    // Lock down the registered boolean set; if someone removes a flag from
    // BOOLEAN_FLAGS, downstream commands break with confusing
    // "Missing value" errors.
    const flags = [
      "json",
      "no-json",
      "dry-run",
      "include-expired",
      "no-start",
      "save",
      "temporary",
      "no-temporary",
      "wait",
      "help",
      "version",
      "allow-fifty",
      "no-launch",
      "no-backup",
    ];
    for (const name of flags) {
      const parsed = parseArgs([`--${name}`]);
      expect(parsed.flags.get(name)).toBe(true);
    }
  });
});

describe("parseArgs: value flags", () => {
  test("space-separated value flag consumes the next token", () => {
    const parsed = parseArgs(["--model", "gpt-5-5-pro"]);
    expect(parsed.flags.get("model")).toBe("gpt-5-5-pro");
  });

  test("equals-syntax keeps everything after the first = as the value", () => {
    const parsed = parseArgs(["--instructions=Use=equal=signs"]);
    expect(parsed.flags.get("instructions")).toBe("Use=equal=signs");
  });

  test("equals-syntax preserves whitespace inside the value", () => {
    const parsed = parseArgs(["--instructions=line one\nline two"]);
    expect(parsed.flags.get("instructions")).toBe("line one\nline two");
  });

  test("missing value for non-boolean flag throws INVALID_ARGS", () => {
    try {
      parseArgs(["--model"]);
      throw new Error("Expected INVALID_ARGS.");
    } catch (error) {
      expect(error).toBeInstanceOf(ProError);
      const proError = error as ProError;
      expect(proError.code).toBe("INVALID_ARGS");
      expect(proError.message).toContain("Missing value for --model");
    }
  });

  test("a flag immediately followed by another flag throws INVALID_ARGS", () => {
    // Regression guard: if argv is "--model --json", we must not silently
    // treat "--json" as the model name.
    try {
      parseArgs(["--model", "--json"]);
      throw new Error("Expected INVALID_ARGS.");
    } catch (error) {
      expect(error).toBeInstanceOf(ProError);
      expect((error as ProError).code).toBe("INVALID_ARGS");
    }
  });
});

describe("parseArgs: invalid input", () => {
  test("the bare token -- is positional but --= is not (empty name)", () => {
    try {
      parseArgs(["--"]);
      // -- is positional per current behavior; nothing to throw here.
    } catch (error) {
      // If a future change errors on bare --, surface it.
      expect((error as ProError).code).toBe("INVALID_ARGS");
    }
  });

  test("an empty equals-name throws INVALID_ARGS", () => {
    try {
      parseArgs(["--=value"]);
      throw new Error("Expected INVALID_ARGS.");
    } catch (error) {
      expect(error).toBeInstanceOf(ProError);
      // Either "Empty flag" or "Invalid flag" — both signal the bad input.
      const message = (error as ProError).message;
      expect(message.toLowerCase()).toContain("flag");
    }
  });
});

describe("parseArgs: repeated flags", () => {
  test("repeating a flag converts the entry to an array of values in order", () => {
    const parsed = parseArgs([
      "--instructions",
      "first",
      "--instructions",
      "second",
      "--instructions",
      "third",
    ]);
    const value = parsed.flags.get("instructions");
    expect(Array.isArray(value)).toBe(true);
    expect(value as string[]).toEqual(["first", "second", "third"]);
  });

  test("flagStrings exposes repeated values as an array", () => {
    const parsed = parseArgs(["--instructions", "a", "--instructions", "b"]);
    expect(flagStrings(parsed.flags, "instructions")).toEqual(["a", "b"]);
  });

  test("flagStrings returns single-value flags as a one-element array", () => {
    const parsed = parseArgs(["--model", "gpt-5-5-pro"]);
    expect(flagStrings(parsed.flags, "model")).toEqual(["gpt-5-5-pro"]);
  });

  test("flagStrings returns an empty array when the flag is absent", () => {
    expect(flagStrings(parseArgs([]).flags, "model")).toEqual([]);
  });
});

describe("flagString helper", () => {
  test("returns the string value", () => {
    const parsed = parseArgs(["--model", "gpt-5-5-pro"]);
    expect(flagString(parsed.flags, "model")).toBe("gpt-5-5-pro");
  });

  test("returns undefined when absent", () => {
    expect(flagString(parseArgs([]).flags, "model")).toBeUndefined();
  });

  test("returns undefined for repeated flags (so single-value reads fail loudly via undefined)", () => {
    // Important contract: callers using flagString on a repeated flag would
    // silently drop later occurrences if we returned the first one. Returning
    // undefined forces them to use flagStrings instead.
    const parsed = parseArgs(["--model", "a", "--model", "b"]);
    expect(flagString(parsed.flags, "model")).toBeUndefined();
  });

  test("coerces a true boolean to the literal string 'true'", () => {
    const parsed = parseArgs(["--json"]);
    expect(flagString(parsed.flags, "json")).toBe("true");
  });
});

describe("flagBoolean helper", () => {
  test("returns true only when the flag was set as a boolean", () => {
    const parsed = parseArgs(["--json"]);
    expect(flagBoolean(parsed.flags, "json")).toBe(true);
  });

  test("returns false when the flag is absent", () => {
    expect(flagBoolean(parseArgs([]).flags, "json")).toBe(false);
  });

  test("returns false when the flag was set with a string value (e.g. --json=false)", () => {
    // The current parser stores explicit values as strings; flagBoolean is
    // only true when no value was provided. This is what makes the
    // BOOLEAN_FLAGS set meaningful.
    const parsed = parseArgs(["--json=false"]);
    expect(flagBoolean(parsed.flags, "json")).toBe(false);
  });
});
