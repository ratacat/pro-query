import { describe, expect, test } from "bun:test";
import {
  aggregateOdds,
  buildOddsInstructions,
  buildOddsPrompt,
  parseOddsResponse,
} from "../src/odds";

describe("parseOddsResponse", () => {
  test("parses bare integer", () => {
    expect(parseOddsResponse("92", false).value).toBe(92);
  });

  test("trims whitespace", () => {
    expect(parseOddsResponse("  47\n", false).value).toBe(47);
  });

  test("falls back to first integer in noisy text", () => {
    expect(parseOddsResponse("My estimate: 73.", false).value).toBe(73);
  });

  test("rejects out-of-range integers", () => {
    expect(parseOddsResponse("250", false).value).toBe(null);
    expect(parseOddsResponse("999", false).value).toBe(null);
  });

  test("forbids 50 by default and flags it", () => {
    const r = parseOddsResponse("50", false);
    expect(r.value).toBe(null);
    expect(r.rejectedFifty).toBe(true);
  });

  test("allows 50 when allowFifty is true", () => {
    expect(parseOddsResponse("50", true).value).toBe(50);
  });

  test("returns null for non-numeric responses", () => {
    expect(parseOddsResponse("I cannot answer.", false).value).toBe(null);
  });

  test("accepts boundary 0 and 100", () => {
    expect(parseOddsResponse("0", false).value).toBe(0);
    expect(parseOddsResponse("100", false).value).toBe(100);
  });
});

describe("aggregateOdds", () => {
  test("mean", () => {
    expect(aggregateOdds([60, 70, 80], "mean")).toBe(70);
  });

  test("median odd length", () => {
    expect(aggregateOdds([60, 95, 70], "median")).toBe(70);
  });

  test("median even length", () => {
    expect(aggregateOdds([60, 70, 80, 90], "median")).toBe(75);
  });

  test("trimmed-mean drops ends", () => {
    expect(aggregateOdds([0, 50, 50, 50, 100], "trimmed-mean")).toBe(50);
  });

  test("trimmed-mean falls back to mean below threshold", () => {
    expect(aggregateOdds([10, 90], "trimmed-mean")).toBe(50);
  });

  test("throws on empty input", () => {
    expect(() => aggregateOdds([], "mean")).toThrow();
  });
});

describe("buildOddsPrompt", () => {
  test("includes context block when provided", () => {
    const p = buildOddsPrompt("Will X happen?", "Evidence A about X.");
    expect(p).toContain("CONTEXT:");
    expect(p).toContain("Evidence A about X.");
    expect(p).toContain("QUESTION:");
    expect(p).toContain("Will X happen?");
  });

  test("omits context block when absent", () => {
    const p = buildOddsPrompt("Will X happen?");
    expect(p).not.toContain("CONTEXT:");
    expect(p).toContain("Will X happen?");
  });

  test("omits context block when only whitespace", () => {
    const p = buildOddsPrompt("Will X happen?", "   \n  ");
    expect(p).not.toContain("CONTEXT:");
  });
});

describe("buildOddsInstructions", () => {
  test("forbids 50 by default", () => {
    const text = buildOddsInstructions(false);
    expect(text).toContain("Do NOT output 50");
    expect(text).toContain("integer between 0 and 100");
  });

  test("allows 50 when configured", () => {
    const text = buildOddsInstructions(true);
    expect(text).not.toContain("Do NOT output 50");
    expect(text).toContain("output 50");
  });
});
