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

  test("rejects negative integers instead of stripping the sign", () => {
    const r = parseOddsResponse("-73", false);
    expect(r.value).toBe(null);
    expect(r.rejectedFifty).toBe(false);
  });

  test("rejects decimal probabilities instead of truncating at the dot", () => {
    const r = parseOddsResponse("My estimate: 73.5%", false);
    expect(r.value).toBe(null);
    expect(r.rejectedFifty).toBe(false);
  });

  test("picks the FIRST integer when noisy text has multiple candidates", () => {
    // Regression guard: if the regex changes to greedy, this could pick 99.
    expect(parseOddsResponse("Between 60 and 99 percent.", false).value).toBe(60);
  });

  test("rejects multi-digit values starting with leading zero only when also out of range", () => {
    // "007" parses as 7 (loose match) — not rejected since 7 is in range.
    expect(parseOddsResponse("007", false).value).toBe(7);
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

  test("single value passes through every aggregator", () => {
    expect(aggregateOdds([42], "mean")).toBe(42);
    expect(aggregateOdds([42], "median")).toBe(42);
    expect(aggregateOdds([42], "trimmed-mean")).toBe(42);
  });

  test("trimmed-mean uses 10% trim minimum 1 from each end", () => {
    // values length 10 → trim = max(1, floor(1)) = 1 from each end → mean of middle 8.
    expect(aggregateOdds([0, 50, 50, 50, 50, 50, 50, 50, 50, 100], "trimmed-mean")).toBe(50);
  });

  test("aggregators do not mutate the input array", () => {
    // Regression guard: a refactor that sorts in place would corrupt
    // attempt-level data shown to users.
    const input = [60, 95, 70];
    aggregateOdds(input, "median");
    expect(input).toEqual([60, 95, 70]);
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
