import { describe, expect, test } from "bun:test";
import { updateProCli, type UpdateStep } from "../src/update";

describe("updateProCli", () => {
  test("fast-forwards, relinks, then restarts the daemon before reporting version", () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const repoRoot = "/tmp/pro-cli";
    const runCommand = (command: string, args: string[], cwd?: string): UpdateStep => {
      calls.push({ command, args, cwd });
      const rendered = [command, ...args].join(" ");
      if (rendered === `git -C ${repoRoot} remote get-url origin`) {
        return { command: rendered, output: "https://github.com/ratacat/pro-cli.git\n" };
      }
      if (rendered === `git -C ${repoRoot} branch --show-current`) {
        return { command: rendered, output: "main\n" };
      }
      if (rendered === `git -C ${repoRoot} status --porcelain`) {
        return { command: rendered, output: "" };
      }
      if (rendered === `git -C ${repoRoot} pull --ff-only origin main`) {
        return { command: rendered, output: "Already up to date." };
      }
      if (rendered === "bun install") {
        expect(cwd).toBe(repoRoot);
        return { command: rendered, output: "installed" };
      }
      if (rendered === "bun link") {
        expect(cwd).toBe(repoRoot);
        return { command: rendered, output: "linked" };
      }
      if (rendered === "pro-cli daemon restart --json") {
        return { command: rendered, output: '{"ok":true}' };
      }
      if (rendered === "pro-cli --version") {
        return { command: rendered, output: "pro-cli 0.1.0\n" };
      }
      throw new Error(`Unexpected command: ${rendered}`);
    };

    const result = updateProCli({ repoRoot, runCommand });

    expect(result.version).toBe("pro-cli 0.1.0");
    expect(result.steps.map((step) => step.command)).toEqual([
      `git -C ${repoRoot} pull --ff-only origin main`,
      "bun install",
      "bun link",
      "pro-cli daemon restart --json",
    ]);
    expect(calls.map((call) => [call.command, ...call.args].join(" "))).toEqual([
      `git -C ${repoRoot} remote get-url origin`,
      `git -C ${repoRoot} branch --show-current`,
      `git -C ${repoRoot} status --porcelain`,
      `git -C ${repoRoot} pull --ff-only origin main`,
      "bun install",
      "bun link",
      "pro-cli daemon restart --json",
      "pro-cli --version",
    ]);
  });
});
