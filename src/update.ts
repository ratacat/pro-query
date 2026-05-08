import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, ProError } from "./errors";

const REPO_URL = "https://github.com/ratacat/pro-cli.git";
const ALLOWED_ORIGINS = new Set([
  REPO_URL,
  "https://github.com/ratacat/pro-cli",
  "git@github.com:ratacat/pro-cli.git",
]);

export interface UpdateStep {
  command: string;
  output: string;
}

export interface UpdateResult {
  repoRoot: string;
  branch: string;
  version: string;
  steps: UpdateStep[];
}

export function updateProCli(): UpdateResult {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const origin = run("git", ["-C", repoRoot, "remote", "get-url", "origin"]).output.trim();
  if (!ALLOWED_ORIGINS.has(origin)) {
    throw new ProError("UPDATE_WRONG_ORIGIN", `Refusing to update checkout with origin ${origin}.`, {
      exitCode: EXIT.invalidArgs,
      suggestions: [`Expected ${REPO_URL}.`],
    });
  }

  const branch = run("git", ["-C", repoRoot, "branch", "--show-current"]).output.trim();
  if (!branch) {
    throw new ProError("UPDATE_DETACHED_HEAD", "Refusing to update a detached checkout.", {
      exitCode: EXIT.invalidArgs,
      suggestions: ["Check out main, then rerun pro-cli update."],
    });
  }
  if (branch !== "main") {
    throw new ProError("UPDATE_WRONG_BRANCH", `Refusing to update branch ${branch}.`, {
      exitCode: EXIT.invalidArgs,
      suggestions: ["Switch to main, then rerun pro-cli update."],
    });
  }

  const dirty = run("git", ["-C", repoRoot, "status", "--porcelain"]).output.trim();
  if (dirty) {
    throw new ProError("UPDATE_DIRTY_WORKTREE", "Refusing to update with uncommitted changes.", {
      exitCode: EXIT.invalidArgs,
      suggestions: ["Commit or stash changes, then rerun pro-cli update."],
    });
  }

  const steps = [
    run("git", ["-C", repoRoot, "pull", "--ff-only", "origin", "main"]),
    run("bun", ["install"], repoRoot),
    run("bun", ["link"], repoRoot),
  ];
  const version = run("pro-cli", ["--version"]).output.trim();

  return { repoRoot, branch, version, steps };
}

function run(command: string, args: string[], cwd?: string): UpdateStep {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
  });
  const renderedCommand = [command, ...args].join(" ");
  if (result.error || result.status !== 0) {
    throw new ProError("UPDATE_COMMAND_FAILED", `${renderedCommand} failed.`, {
      exitCode: EXIT.internal,
      suggestions: ["Inspect the command output, fix the checkout, then rerun pro-cli update."],
      details: {
        command: renderedCommand,
        status: result.status,
        stderr: compact(result.stderr || result.error?.message || ""),
        stdout: compact(result.stdout || ""),
      },
      cause: result.error,
    });
  }
  return {
    command: renderedCommand,
    output: compact(result.stdout || result.stderr || ""),
  };
}

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 500);
}
