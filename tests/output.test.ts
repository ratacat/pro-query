import { describe, expect, test } from "bun:test";
import { ProError } from "../src/errors";
import { renderText, writeError, writeSuccess, type CliIO } from "../src/output";

function captureIO(): CliIO & { lines: { stdout: string; stderr: string } } {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
    stdoutIsTTY: false,
    env: {},
    cwd: "/tmp",
    lines: {
      get stdout() {
        return stdout;
      },
      get stderr() {
        return stderr;
      },
    },
  } as unknown as CliIO & { lines: { stdout: string; stderr: string } };
}

describe("writeSuccess: JSON envelope", () => {
  test("wraps payload in { ok: true, data: ... }", () => {
    const io = captureIO();
    writeSuccess(io, { json: true }, { hello: "world" });
    const payload = JSON.parse(io.lines.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.data.hello).toBe("world");
  });

  test("appends a single trailing newline (line-delimited JSON safe)", () => {
    const io = captureIO();
    writeSuccess(io, { json: true }, { hello: "world" });
    expect(io.lines.stdout.endsWith("\n")).toBe(true);
    expect(io.lines.stdout.split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("never writes to stderr in success mode", () => {
    const io = captureIO();
    writeSuccess(io, { json: true }, { hello: "world" });
    expect(io.lines.stderr).toBe("");
  });
});

describe("writeSuccess: agentInstruction wrapping", () => {
  test("adds agentInstruction and resultStats when payload has a string result", () => {
    const io = captureIO();
    writeSuccess(io, { json: true }, { result: "Hello agent." });
    const payload = JSON.parse(io.lines.stdout);
    expect(payload.data.result).toBe("Hello agent.");
    expect(payload.data.agentInstruction).toContain("data.result is the primary deliverable");
    expect(payload.data.resultStats).toMatchObject({
      chars: "Hello agent.".length,
      approximateTokens: Math.ceil("Hello agent.".length / 4),
      fullRelayThresholdChars: 6000,
      fullRelayThresholdApproxTokens: 1500,
    });
  });

  test("agentInstruction tells agents not to send probe queries (regression guard)", () => {
    // Verify the no-test-probe guidance is present. This text drives agent
    // behavior to avoid burning Pro quota on smoke tests.
    const io = captureIO();
    writeSuccess(io, { json: true }, { result: "x" });
    const payload = JSON.parse(io.lines.stdout);
    expect(payload.data.agentInstruction.toLowerCase()).toContain("probe");
    expect(payload.data.agentInstruction.toLowerCase()).toContain("smoke-test");
    expect(payload.data.agentInstruction).toContain("Pro quota");
  });

  test("does NOT add agentInstruction to payloads that lack a string result", () => {
    // Setup output, doctor output, etc. should not receive the relay
    // instruction (it would mislead agents into condensing diagnostic JSON).
    const io = captureIO();
    writeSuccess(io, { json: true }, { ready: true, transport: { status: "configured" } });
    const payload = JSON.parse(io.lines.stdout);
    expect("agentInstruction" in payload.data).toBe(false);
    expect("resultStats" in payload.data).toBe(false);
  });

  test("does NOT add agentInstruction when result is non-string (e.g. structured object)", () => {
    const io = captureIO();
    writeSuccess(io, { json: true }, { result: { parsed: { name: "Alice" } } });
    const payload = JSON.parse(io.lines.stdout);
    expect("agentInstruction" in payload.data).toBe(false);
  });

  test("computes resultStats accurately for empty and large strings", () => {
    const io = captureIO();
    writeSuccess(io, { json: true }, { result: "" });
    const payload = JSON.parse(io.lines.stdout);
    expect(payload.data.resultStats.chars).toBe(0);
    expect(payload.data.resultStats.approximateTokens).toBe(0);

    const io2 = captureIO();
    const big = "x".repeat(8000);
    writeSuccess(io2, { json: true }, { result: big });
    const payload2 = JSON.parse(io2.lines.stdout);
    expect(payload2.data.resultStats.chars).toBe(8000);
    expect(payload2.data.resultStats.approximateTokens).toBe(2000);
  });
});

describe("writeError: JSON envelope", () => {
  test("wraps error in { ok: false, error: { code, message, suggestions, ... } } on stderr", () => {
    const io = captureIO();
    writeError(io, { json: true }, new ProError("BAD_THING", "Something broke.", {
      suggestions: ["Try X.", "Then Y."],
      details: { extra: 1 },
    }));
    expect(io.lines.stdout).toBe("");
    const payload = JSON.parse(io.lines.stderr);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("BAD_THING");
    expect(payload.error.message).toBe("Something broke.");
    expect(payload.error.suggestions).toEqual(["Try X.", "Then Y."]);
    expect(payload.error.details).toEqual({ extra: 1 });
  });

  test("error envelope is single-line JSON", () => {
    const io = captureIO();
    writeError(io, { json: true }, new ProError("X", "y"));
    expect(io.lines.stderr.split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("text mode formats CODE: message with suggestions list", () => {
    const io = captureIO();
    writeError(io, { json: false }, new ProError("BAD_THING", "Something broke.", {
      suggestions: ["Try X.", "Then Y."],
    }));
    expect(io.lines.stderr).toContain("BAD_THING");
    expect(io.lines.stderr).toContain("Something broke.");
    expect(io.lines.stderr).toContain("Try X.");
    expect(io.lines.stderr).toContain("Then Y.");
  });

  test("text mode omits 'try:' line when there are no suggestions", () => {
    const io = captureIO();
    writeError(io, { json: false }, new ProError("BAD_THING", "Something broke."));
    expect(io.lines.stderr).toContain("BAD_THING");
    expect(io.lines.stderr).not.toContain("try:");
  });
});

describe("renderText (text-mode formatting)", () => {
  test("renders a string payload verbatim", () => {
    expect(renderText("hello")).toBe("hello");
  });

  test("renders { text: ... } as the text field", () => {
    expect(renderText({ text: "help body", commands: ["a", "b"] })).toBe("help body");
  });

  test("renders { result: <string> } as the result field", () => {
    expect(renderText({ result: "the answer" })).toBe("the answer");
  });

  test("renders setup steps with a leading summary line", () => {
    const text = renderText({
      summary: "needs login",
      steps: [
        { id: "open-chatgpt", status: "todo", command: "open chrome" },
        { id: "capture-auth", status: "todo", command: "pro-cli auth capture" },
      ],
    });
    expect(text).toContain("needs login");
    expect(text).toContain("[todo] open-chatgpt");
    expect(text).toContain("  open chrome");
    expect(text).toContain("[todo] capture-auth");
  });

  test("renders 'Open ChatGPT' block with capture command for auth-command output", () => {
    const text = renderText({
      command: "open -na 'Google Chrome' --args ...",
      captureCommand: "pro-cli auth capture --cdp http://127.0.0.1:9222 --json",
    });
    expect(text).toContain("Open ChatGPT:");
    expect(text).toContain("open -na");
    expect(text).toContain("Then capture:");
    expect(text).toContain("pro-cli auth capture");
  });

  test("renders 'pro-cli ready' / 'not ready' for doctor-style payloads", () => {
    expect(
      renderText({ ready: true, next: { command: "pro-cli ask" } }),
    ).toContain("pro-cli ready");
    expect(
      renderText({ ready: false, next: { command: "pro-cli setup" } }),
    ).toContain("pro-cli not ready");
  });

  test("renders job result hint when job has succeeded", () => {
    const text = renderText({ job: { id: "job_x", status: "succeeded" } });
    expect(text).toContain("job_x succeeded");
    expect(text).toContain("pro-cli job result job_x");
  });

  test("renders job wait hint when job is still in progress", () => {
    const text = renderText({ job: { id: "job_y", status: "running" } });
    expect(text).toContain("job_y running");
    expect(text).toContain("pro-cli job wait job_y");
  });

  test("renders 'still <status>' when wait timed out", () => {
    const text = renderText({
      job: { id: "job_z", status: "running" },
      wait: { timedOut: true, elapsedMs: 60_000 },
    });
    expect(text).toContain("job_z still running");
    expect(text).toContain("60000ms");
    expect(text).toContain("pro-cli job wait job_z");
  });

  test("falls back to JSON.stringify for unknown payload shapes", () => {
    const text = renderText({ unknownShape: 42 });
    expect(text).toBe('{"unknownShape":42}');
  });
});
