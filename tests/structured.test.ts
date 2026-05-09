import { describe, expect, test } from "bun:test";
import {
  buildStructuredInstructions,
  extractJsonFromResponse,
  runStructured,
  validateLightly,
} from "../src/structured";

describe("extractJsonFromResponse", () => {
  test("extracts from a fenced ```json block", () => {
    const text = "Here you go:\n```json\n{\"a\": 1}\n```";
    expect(extractJsonFromResponse(text)).toEqual({ a: 1 });
  });

  test("extracts from a fenced ``` block without language tag", () => {
    expect(extractJsonFromResponse("```\n{\"a\":2}\n```")).toEqual({ a: 2 });
  });

  test("falls back to first balanced object when no fence", () => {
    expect(extractJsonFromResponse('Pre {"name":"Alice","age":30} post.')).toEqual({
      name: "Alice",
      age: 30,
    });
  });

  test("falls back to balanced array when no fence", () => {
    expect(extractJsonFromResponse('Items: [1, 2, 3] done')).toEqual([1, 2, 3]);
  });

  test("handles strings containing braces", () => {
    expect(extractJsonFromResponse('{"text":"contains } and {"}')).toEqual({
      text: "contains } and {",
    });
  });

  test("throws on no JSON-like content", () => {
    expect(() => extractJsonFromResponse("just prose")).toThrow();
  });

  test("throws on unterminated value", () => {
    expect(() => extractJsonFromResponse('{"a": 1')).toThrow();
  });
});

describe("validateLightly", () => {
  test("accepts when no schema is given", () => {
    expect(validateLightly({}, undefined)).toEqual({ ok: true });
  });

  test("rejects mismatched root type", () => {
    const result = validateLightly([], { type: "object" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("object");
  });

  test("checks required fields on object root", () => {
    const result = validateLightly(
      { name: "Alice" },
      { type: "object", required: ["name", "role"] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("role");
  });

  test("accepts valid object", () => {
    expect(
      validateLightly({ name: "Alice", role: "CEO" }, { type: "object", required: ["name"] }),
    ).toEqual({ ok: true });
  });

  test("integer rejects floats", () => {
    expect(validateLightly(3.5, { type: "integer" }).ok).toBe(false);
    expect(validateLightly(3, { type: "integer" }).ok).toBe(true);
  });

  test("type=array passes only arrays", () => {
    expect(validateLightly([1, 2], { type: "array" }).ok).toBe(true);
    expect(validateLightly({}, { type: "array" }).ok).toBe(false);
    expect(validateLightly("abc", { type: "array" }).ok).toBe(false);
  });

  test("type=string passes only strings", () => {
    expect(validateLightly("ok", { type: "string" }).ok).toBe(true);
    expect(validateLightly(0, { type: "string" }).ok).toBe(false);
    expect(validateLightly(null, { type: "string" }).ok).toBe(false);
  });

  test("type=number passes both ints and floats", () => {
    expect(validateLightly(3, { type: "number" }).ok).toBe(true);
    expect(validateLightly(3.5, { type: "number" }).ok).toBe(true);
    expect(validateLightly("3", { type: "number" }).ok).toBe(false);
  });

  test("type=boolean passes only booleans", () => {
    expect(validateLightly(true, { type: "boolean" }).ok).toBe(true);
    expect(validateLightly(false, { type: "boolean" }).ok).toBe(true);
    expect(validateLightly(0, { type: "boolean" }).ok).toBe(false);
    expect(validateLightly("true", { type: "boolean" }).ok).toBe(false);
  });

  test("required-field check is skipped when type is not 'object' (no spurious errors)", () => {
    // Regression guard: required only applies to type=object roots; the
    // implementation explicitly checks both before iterating.
    expect(
      validateLightly([1, 2, 3], { type: "array", required: ["name"] }).ok,
    ).toBe(true);
  });
});

describe("extractJsonFromResponse: nested and tricky inputs", () => {
  test("extracts a deeply nested object", () => {
    const text = '```json\n{"a":{"b":{"c":[1,2,{"d":true}]}}}\n```';
    expect(extractJsonFromResponse(text)).toEqual({ a: { b: { c: [1, 2, { d: true }] } } });
  });

  test("extracts an array containing nested objects", () => {
    expect(extractJsonFromResponse('```json\n[{"a":1},{"b":[2,3]}]\n```')).toEqual([
      { a: 1 },
      { b: [2, 3] },
    ]);
  });

  test("handles strings containing backslash-escaped quotes", () => {
    expect(extractJsonFromResponse('{"q":"he said \\"hi\\""}')).toEqual({ q: 'he said "hi"' });
  });

  test("handles strings containing backslash followed by brace", () => {
    expect(extractJsonFromResponse('{"q":"path\\\\with\\\\braces}"}')).toEqual({
      q: "path\\with\\braces}",
    });
  });

  test("when fence and bare JSON both exist, the fence wins", () => {
    // The fence is the model's intentional output; bare JSON in prose may
    // be quoted from input. Verify fence takes precedence.
    const text = "Background: {\"old\":true}\n\n```json\n{\"new\":true}\n```";
    expect(extractJsonFromResponse(text)).toEqual({ new: true });
  });

  test("when multiple bare JSON blocks exist, picks the FIRST one", () => {
    const text = '{"first":1} other text {"second":2}';
    expect(extractJsonFromResponse(text)).toEqual({ first: 1 });
  });

  test("supports unicode characters inside string values", () => {
    expect(extractJsonFromResponse('{"name":"日本語 🚀"}')).toEqual({ name: "日本語 🚀" });
  });

  test("ignores braces inside fenced blocks that come AFTER the JSON one", () => {
    // Common pattern: the model outputs json then prose with a code block.
    // The first fence is what we want — extractJsonFromResponse returns it.
    const text = '```json\n{"ok":true}\n```\n\nNotes: see ```{example}```';
    expect(extractJsonFromResponse(text)).toEqual({ ok: true });
  });
});

describe("runStructured: validation-failure retry path", () => {
  test("retries when extraction succeeds but the schema rejects the result", async () => {
    // This is distinct from a parse failure: JSON came through fine, but
    // the model didn't include a required field. We must feed back the
    // schema reason and retry, not silently succeed with bad data.
    let calls = 0;
    const result = await runStructured("Q", {
      schema: { type: "object", required: ["name", "role"] },
      retries: 2,
      runner: async (prompt) => {
        calls += 1;
        if (calls === 1) return '```json\n{"name":"Alice"}\n```';
        // After feedback, the model adds the missing field.
        expect(prompt).toContain("PREVIOUS ATTEMPT FAILED");
        expect(prompt.toLowerCase()).toContain("role");
        return '```json\n{"name":"Alice","role":"CEO"}\n```';
      },
    });
    expect(calls).toBe(2);
    expect(result.parsed).toEqual({ name: "Alice", role: "CEO" });
    expect(result.attempts[0].error).toContain("role");
    expect(result.attempts[1].error).toBeNull();
  });
});

describe("buildStructuredInstructions", () => {
  test("schema branch includes the schema and a fence directive", () => {
    const text = buildStructuredInstructions({ type: "object" }, undefined);
    expect(text).toContain("JSON Schema");
    expect(text).toContain('"type": "object"');
    expect(text).toContain("```json");
  });

  test("format branch includes the format hint", () => {
    const text = buildStructuredInstructions(undefined, "{name: string, age: number}");
    expect(text).toContain("Format:");
    expect(text).toContain("name: string");
  });

  test("throws when neither is given", () => {
    expect(() => buildStructuredInstructions(undefined, undefined)).toThrow();
  });
});

describe("runStructured", () => {
  test("accepts a valid first response", async () => {
    let calls = 0;
    const result = await runStructured("Find people", {
      schema: { type: "object", required: ["name"] },
      retries: 1,
      runner: async () => {
        calls += 1;
        return "```json\n{\"name\":\"Alice\"}\n```";
      },
    });
    expect(calls).toBe(1);
    expect(result.parsed).toEqual({ name: "Alice" });
    expect(result.attempts).toHaveLength(1);
  });

  test("retries with feedback after a parse failure", async () => {
    let calls = 0;
    const result = await runStructured("Q", {
      formatHint: "{x: number}",
      retries: 2,
      runner: async (prompt) => {
        calls += 1;
        if (calls === 1) return "no json here at all";
        expect(prompt).toContain("PREVIOUS ATTEMPT FAILED");
        return "```json\n{\"x\":7}\n```";
      },
    });
    expect(calls).toBe(2);
    expect(result.parsed).toEqual({ x: 7 });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].error).not.toBe(null);
    expect(result.attempts[1].error).toBe(null);
  });

  test("throws after exhausting retries", async () => {
    await expect(
      runStructured("Q", {
        schema: { type: "object", required: ["name"] },
        retries: 1,
        runner: async () => "no json",
      }),
    ).rejects.toThrow();
  });

  test("requires schema or formatHint", async () => {
    await expect(
      runStructured("Q", { retries: 0, runner: async () => "{}" }),
    ).rejects.toThrow();
  });
});
