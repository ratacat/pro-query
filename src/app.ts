import { readFile } from "node:fs/promises";
import { flagBoolean, flagString, parseArgs } from "./args";
import { captureAuth, defaultCdpBase, getAuthStatus } from "./auth";
import { loadConfig, resolvePaths, saveConfig } from "./config";
import { EXIT, ProError, toProError } from "./errors";
import { JobStore, redactJob } from "./jobs";
import { listStaticModels } from "./models";
import type { CliIO } from "./output";
import { writeError, writeSuccess } from "./output";
import { runChatGptJob } from "./transport";

const HELP_TEXT =
  "pro: ChatGPT Pro CLI\nauth capture|status, models, submit, status, result, wait, cancel, jobs, doctor\nUse --json for agents.";

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(argv);
  const mode = {
    json: flagBoolean(parsed.flags, "json") || (!flagBoolean(parsed.flags, "no-json") && !io.stdoutIsTTY),
  };

  try {
    const [command, subcommand, ...rest] = parsed.positionals;
    if (!command || command === "help" || command === "--help") {
      writeSuccess(io, mode, { text: HELP_TEXT, commands: commandList() });
      return EXIT.success;
    }

    const config = await loadConfig(io.env);
    const paths = resolvePaths(io.env, config);

    switch (command) {
      case "auth": {
        if (subcommand === "status") {
          writeSuccess(io, mode, await getAuthStatus(paths));
          return EXIT.success;
        }
        if (subcommand === "capture") {
          const cdpBase = defaultCdpBase(flagString(parsed.flags, "port"), flagString(parsed.flags, "cdp"));
          const jsonPath = flagString(parsed.flags, "out") ?? paths.cookieJsonPath;
          const jarPath = flagString(parsed.flags, "jar") ?? paths.cookieJarPath;
          const tokenPath = flagString(parsed.flags, "token-out") ?? paths.sessionTokenPath;
          const status = await captureAuth({
            cdpBase,
            jsonPath,
            jarPath,
            tokenPath,
            dryRun: flagBoolean(parsed.flags, "dry-run"),
          });
          await saveConfig(io.env, {
            ...config,
            cookieJsonPath: jsonPath,
            cookieJarPath: jarPath,
            sessionTokenPath: tokenPath,
          });
          writeSuccess(io, mode, status);
          return EXIT.success;
        }
        throw invalidArgs("Unknown auth command.", ["Use pro auth status or pro auth capture."]);
      }
      case "models": {
        writeSuccess(io, mode, listStaticModels());
        return EXIT.success;
      }
      case "submit": {
        const prompt = await promptFromArgs([subcommand, ...rest].filter(Boolean), io.cwd);
        const store = await JobStore.open(paths.dbPath);
        try {
          const job = store.create({
            prompt,
            model: flagString(parsed.flags, "model") ?? config.defaultModel ?? "auto",
            reasoning: flagString(parsed.flags, "reasoning") ?? config.defaultReasoning ?? "auto",
            options: collectSubmitOptions(parsed.flags),
          });
          writeSuccess(io, mode, { job });
          return EXIT.success;
        } finally {
          store.close();
        }
      }
      case "status": {
        const jobId = subcommand;
        if (!jobId) throw invalidArgs("Missing job id.", ["Use pro status <job-id>."]);
        const store = await JobStore.open(paths.dbPath);
        try {
          writeSuccess(io, mode, { job: redactJob(store.get(jobId)) });
          return EXIT.success;
        } finally {
          store.close();
        }
      }
      case "result": {
        const jobId = subcommand;
        if (!jobId) throw invalidArgs("Missing job id.", ["Use pro result <job-id>."]);
        const store = await JobStore.open(paths.dbPath);
        try {
          const job = store.get(jobId);
          if (job.status !== "succeeded") {
            throw new ProError("JOB_NOT_READY", `Job ${jobId} is ${job.status}.`, {
              exitCode: EXIT.notFound,
              suggestions: ["Run pro wait <job-id> or pro status <job-id>."],
            });
          }
          writeSuccess(io, mode, { jobId, result: job.result });
          return EXIT.success;
        } finally {
          store.close();
        }
      }
      case "wait": {
        const jobId = subcommand;
        if (!jobId) throw invalidArgs("Missing job id.", ["Use pro wait <job-id>."]);
        const store = await JobStore.open(paths.dbPath);
        try {
          const job = store.get(jobId);
          if (job.status === "queued") {
            store.markRunning(jobId);
            try {
              const result = await runChatGptJob(store.get(jobId), {
                sessionTokenPath: paths.sessionTokenPath,
              });
              writeSuccess(io, mode, { job: redactJob(store.markSucceeded(jobId, result)) });
            } catch (error) {
              const proError = toProError(error);
              writeSuccess(io, mode, {
                job: redactJob(store.markFailed(jobId, proError)),
                error: proError.toPayload(),
              });
            }
            return EXIT.success;
          }
          writeSuccess(io, mode, { job: redactJob(job) });
          return EXIT.success;
        } finally {
          store.close();
        }
      }
      case "cancel": {
        const jobId = subcommand;
        if (!jobId) throw invalidArgs("Missing job id.", ["Use pro cancel <job-id>."]);
        const store = await JobStore.open(paths.dbPath);
        try {
          writeSuccess(io, mode, { job: store.cancel(jobId) });
          return EXIT.success;
        } finally {
          store.close();
        }
      }
      case "jobs": {
        const limit = Number(flagString(parsed.flags, "limit") ?? "20");
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          throw invalidArgs("Invalid --limit.", ["Use --limit between 1 and 200."]);
        }
        const store = await JobStore.open(paths.dbPath);
        try {
          writeSuccess(io, mode, { jobs: store.list(limit) });
          return EXIT.success;
        } finally {
          store.close();
        }
      }
      case "config": {
        if (subcommand === "get") {
          writeSuccess(io, mode, { config, paths: redactPaths(paths) });
          return EXIT.success;
        }
        if (subcommand === "set") {
          const [key, value] = rest;
          if (!key || !value) throw invalidArgs("Missing config key/value.", ["Use pro config set model auto."]);
          const next = { ...config };
          if (key === "model") next.defaultModel = value;
          else if (key === "reasoning") next.defaultReasoning = value;
          else throw invalidArgs(`Unknown config key ${key}.`, ["Supported keys: model, reasoning."]);
          await saveConfig(io.env, next);
          writeSuccess(io, mode, { config: next });
          return EXIT.success;
        }
        throw invalidArgs("Unknown config command.", ["Use pro config get or pro config set."]);
      }
      case "doctor": {
        const auth = await getAuthStatus(paths);
        writeSuccess(io, mode, {
          auth,
          storage: { home: paths.home, dbPath: paths.dbPath },
          transport: {
            status: auth.tokenStatus === "present" ? "configured" : "auth_required",
            endpoint: "https://chatgpt.com/backend-api/codex/responses",
          },
        });
        return EXIT.success;
      }
      default:
        throw invalidArgs(`Unknown command ${command}.`, ["Run pro help."]);
    }
  } catch (error) {
    const proError = toProError(error);
    writeError(io, mode, proError);
    return proError.exitCode;
  }
}

function invalidArgs(message: string, suggestions: string[]): ProError {
  return new ProError("INVALID_ARGS", message, { exitCode: EXIT.invalidArgs, suggestions });
}

function commandList(): string[] {
  return [
    "auth status",
    "auth capture",
    "models",
    "submit",
    "status",
    "result",
    "wait",
    "cancel",
    "jobs",
    "config get",
    "doctor",
  ];
}

async function promptFromArgs(args: string[], cwd: string): Promise<string> {
  const prompt = args.join(" ").trim();
  if (!prompt) throw invalidArgs("Missing prompt.", ["Use pro submit \"prompt\" or pro submit @prompt.md."]);
  if (prompt.startsWith("@") && !prompt.includes(" ")) {
    return readFile(new URL(prompt.slice(1), `file://${cwd}/`), "utf8");
  }
  return prompt;
}

function collectSubmitOptions(flags: Map<string, string | boolean | string[]>): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const key of ["temperature", "timeout", "conversation", "reasoning", "model"]) {
    const value = flagString(flags, key);
    if (value !== undefined) options[key] = value;
  }
  return options;
}

function redactPaths(paths: { home: string; configPath: string; dbPath: string }): {
  home: string;
  configPath: string;
  dbPath: string;
} {
  return {
    home: paths.home,
    configPath: paths.configPath,
    dbPath: paths.dbPath,
  };
}
