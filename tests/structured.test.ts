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
