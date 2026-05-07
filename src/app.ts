import { mkdirSync } from "node:fs";
import { openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import packageJson from "../package.json" with { type: "json" };
import { flagBoolean, flagString, parseArgs } from "./args";
import { captureAuth, defaultCdpBase, getAuthStatus, getBrowserSessionStatus } from "./auth";
import { loadConfig, resolvePaths, saveConfig } from "./config";
import { EXIT, ProError, toProError } from "./errors";
import { JobStore, redactJob } from "./jobs";
import { listModels } from "./models";
import type { CliIO } from "./output";
import { writeError, writeSuccess } from "./output";
import { runChatGptJob } from "./transport";

const REASONING_LEVELS = ["auto", "low", "medium", "high", "extended", "min", "standard", "max"];

const HELP_TEXT =
  "pro: ChatGPT Pro CLI\nsetup, auth command, auth capture, auth status, models, run, submit, wait, result, jobs, doctor\nUse --json for agents.";

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(argv);
  const mode = {
    json: flagBoolean(parsed.flags, "json") || (!flagBoolean(parsed.flags, "no-json") && !io.stdoutIsTTY),
  };

  try {
    const [command, subcommand, ...rest] = parsed.positionals;
    if (flagBoolean(parsed.flags, "version") || command === "version") {
      io.stdout(`pro ${packageJson.version}\n`);
      return EXIT.success;
    }

    if (
      !command ||
      flagBoolean(parsed.flags, "help") ||
      command === "help" ||
      command === "--help"
    ) {
      writeSuccess(io, mode, { text: HELP_TEXT, commands: commandList() });
      return EXIT.success;
    }

    const config = await loadConfig(io.env);
    const paths = resolvePaths(io.env, config);

    switch (command) {
      case "setup": {
        const auth = await getAuthStatus(paths);
        const port = flagString(parsed.flags, "port") ?? "9222";
        writeSuccess(io, mode, buildSetupGuide(auth, paths.home, port));
        return EXIT.success;
      }
      case "auth": {
        if (subcommand === "status") {
          writeSuccess(io, mode, await getAuthStatus(paths));
          return EXIT.success;
        }
        if (subcommand === "command") {
          writeSuccess(io, mode, buildAuthCommand(paths.home, flagString(parsed.flags, "port") ?? "9222"));
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
        writeSuccess(io, mode, await listModels({ sessionTokenPath: paths.sessionTokenPath }));
        return EXIT.success;
      }
      case "submit": {
        const prompt = await promptFromArgs([subcommand, ...rest].filter(Boolean), io.cwd);
        const store = await JobStore.open(paths.dbPath);
        try {
          const job = store.create({
            prompt,
            model: flagString(parsed.flags, "model") ?? config.defaultModel ?? "auto",
            reasoning: resolveReasoning(flagString(parsed.flags, "reasoning") ?? config.defaultReasoning ?? "auto"),
            options: await collectSubmitOptions(parsed.flags, io.cwd),
          });
          const workerStarted = !flagBoolean(parsed.flags, "no-start");
          if (workerStarted) startBackgroundWorker(job.id, io, paths.home);
          writeSuccess(io, mode, { job, worker: { started: workerStarted } });
          return EXIT.success;
        } finally {
          store.close();
        }
      }
      case "run": {
        const prompt = await promptFromArgs([subcommand, ...rest].filter(Boolean), io.cwd);
        const store = await JobStore.open(paths.dbPath);
        try {
          const created = store.create({
            prompt,
            model: flagString(parsed.flags, "model") ?? config.defaultModel ?? "auto",
            reasoning: resolveReasoning(flagString(parsed.flags, "reasoning") ?? config.defaultReasoning ?? "auto"),
            options: await collectSubmitOptions(parsed.flags, io.cwd),
          });
          const executed = await executeQueuedJob(store, created.id, paths);
          writeSuccess(io, mode, executed);
          return EXIT.success;
        } finally {
          store.close();
        }
      }
      case "worker": {
        const jobId = subcommand;
        if (!jobId) throw invalidArgs("Missing job id.", ["Use pro worker <job-id>."]);
        const store = await JobStore.open(paths.dbPath);
        try {
          writeSuccess(io, mode, await executeQueuedJob(store, jobId, paths));
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
        const waitTimeoutMs = parseIntegerFlag(parsed.flags, "wait-timeout", 0, 0, 24 * 60 * 60_000);
        const pollMs = parseIntegerFlag(parsed.flags, "poll-ms", 500, 25, 60_000);
        const store = await JobStore.open(paths.dbPath);
        try {
          const job = store.get(jobId);
          if (job.status === "queued") {
            writeSuccess(io, mode, await executeQueuedJob(store, jobId, paths));
            return EXIT.success;
          }
          if (job.status === "running") {
            writeSuccess(io, mode, { job: redactJob(await waitForTerminalJob(store, jobId, waitTimeoutMs, pollMs)) });
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
          else if (key === "reasoning") next.defaultReasoning = resolveReasoning(value);
          else throw invalidArgs(`Unknown config key ${key}.`, ["Supported keys: model, reasoning."]);
          await saveConfig(io.env, next);
          writeSuccess(io, mode, { config: next });
          return EXIT.success;
        }
        throw invalidArgs("Unknown config command.", ["Use pro config get or pro config set."]);
      }
      case "doctor": {
        const auth = await getAuthStatus(paths);
        const cdpBase = defaultCdpBase(flagString(parsed.flags, "port"), flagString(parsed.flags, "cdp"));
        const browserSession = await getBrowserSessionStatus(
          cdpBase,
          parseIntegerFlag(parsed.flags, "timeout", 3_000, 1, 60_000),
        );
        const authReady = auth.tokenStatus === "present" && auth.accountIdPresent;
        const ready = authReady && browserSession.status === "present";
        writeSuccess(io, mode, {
          auth,
          browserSession,
          ready,
          next: buildDoctorNext(authReady, browserSession.status, cdpBase),
          storage: { home: paths.home, dbPath: paths.dbPath },
          transport: {
            status: ready ? "configured" : "auth_required",
            endpoint: "https://chatgpt.com/backend-api/f/conversation",
          },
          safety: safetySummary(),
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
    "setup",
    "auth command",
    "auth status",
    "auth capture",
    "models",
    "submit",
    "run",
    "status",
    "result",
    "wait",
    "cancel",
    "jobs",
    "config get",
    "doctor",
  ];
}

function buildDoctorNext(
  authReady: boolean,
  browserStatus: Awaited<ReturnType<typeof getBrowserSessionStatus>>["status"],
  cdpBase: string,
): Record<string, string> {
  if (authReady && browserStatus === "present") {
    return {
      command: `pro run "Reply with OK only." --cdp ${cdpBase} --json`,
      reason: "Stored auth and the live CDP ChatGPT page are ready; run a smoke query.",
    };
  }
  if (authReady && browserStatus === "logged_out") {
    return {
      command: `pro auth capture --cdp ${cdpBase} --json`,
      reason: "The CDP ChatGPT page is reachable but logged out; sign in there, then recapture auth.",
    };
  }
  if (authReady && (browserStatus === "page_missing" || browserStatus === "cdp_unavailable")) {
    return {
      command: "pro auth command --json",
      reason: "Stored auth exists, but no live ChatGPT CDP page is available.",
    };
  }
  return {
    command: "pro setup --json",
    reason: "Auth is missing or expired; follow the setup steps.",
  };
}

function buildSetupGuide(auth: Awaited<ReturnType<typeof getAuthStatus>>, home: string, port: string): Record<string, unknown> {
  const ready = auth.tokenStatus === "present" && auth.accountIdPresent;
  const authCommand = buildAuthCommand(home, port);
  return {
    ready,
    summary: ready ? "pro is ready to query ChatGPT." : "pro needs a logged-in ChatGPT browser session.",
    steps: [
      {
        id: "install",
        status: "done",
        command: "curl -fsSL https://raw.githubusercontent.com/ratacat/pro-cli/main/scripts/install.sh | bash",
        note: "Clones or updates ~/Projects/pro-cli and links the pro binary.",
      },
      {
        id: "open-chatgpt",
        status: ready ? "done" : "todo",
        command: authCommand.command,
        note: "Uses a dedicated Chrome profile under ~/.pro so CDP is not attached to your main browser.",
      },
      {
        id: "capture-auth",
        status: ready ? "done" : "todo",
        command: authCommand.captureCommand,
        note: "Captures scoped cookies plus the page session token into private local files.",
      },
      {
        id: "smoke-test",
        status: ready ? "todo" : "blocked",
        command: `pro run "Reply with OK only." --cdp ${authCommand.cdp} --reasoning low --json`,
        note: "Verifies the live ChatGPT backend request path.",
      },
    ],
    auth,
    storage: {
      home,
      cookieJsonPath: auth.cookieJsonPath,
      sessionTokenPath: auth.sessionTokenPath,
    },
    safety: safetySummary(),
  };
}

function buildAuthCommand(home: string, port: string): Record<string, unknown> {
  const profileDir = join(home, "chrome-profile");
  const url = "https://chatgpt.com/";
  const cdp = `http://127.0.0.1:${port}`;
  const command =
    process.platform === "darwin"
      ? `open -na "Google Chrome" --args --user-data-dir=${shellQuote(profileDir)} --remote-debugging-port=${port} ${url}`
      : process.platform === "win32"
        ? `start "" chrome.exe --user-data-dir=${windowsQuote(profileDir)} --remote-debugging-port=${port} ${url}`
        : `google-chrome --user-data-dir=${shellQuote(profileDir)} --remote-debugging-port=${port} ${url}`;
  return {
    command,
    captureCommand: `pro auth capture --cdp ${cdp} --json`,
    cdp,
    profileDir,
    port,
    safety: "Recommended profile is dedicated to pro; do not expose a normal browser profile over CDP.",
  };
}

function safetySummary(): Record<string, unknown> {
  return {
    rawValuesPrinted: false,
    storedLocally: true,
    fileModes: "0600 files, 0700 directories where supported",
    sentTo: ["https://chatgpt.com"],
    reminder: "Cookie and token files are sensitive; do not commit, paste, or share ~/.pro.",
  };
}

async function promptFromArgs(args: string[], cwd: string): Promise<string> {
  const prompt = args.join(" ").trim();
  if (!prompt) throw invalidArgs("Missing prompt.", ["Use pro submit \"prompt\" or pro submit @prompt.md."]);
  if (prompt.startsWith("@") && !prompt.includes(" ")) {
    return readFile(new URL(prompt.slice(1), `file://${cwd}/`), "utf8");
  }
  return prompt;
}

async function collectSubmitOptions(
  flags: Map<string, string | boolean | string[]>,
  cwd: string,
): Promise<Record<string, unknown>> {
  rejectUnsupportedFlags(flags, SUBMIT_FLAGS, "submit/run");
  const options: Record<string, unknown> = {};
  setStringOption(options, "verbosity", flags, "verbosity", ["low", "medium", "high"]);
  setStringOption(options, "reasoningSummary", flags, "reasoning-summary", [
    "auto",
    "concise",
    "detailed",
    "none",
  ]);
  setStringOption(options, "toolChoice", flags, "tool-choice", ["auto", "none", "required"]);
  setIntegerOption(options, "timeoutMs", flags, "timeout", 1, 30 * 60_000);
  setIntegerOption(options, "retries", flags, "retries", 0, 5);
  setIntegerOption(options, "retryDelayMs", flags, "retry-delay", 0, 60_000);
  setBooleanOption(options, "parallelTools", flags, "parallel-tools");
  setConversationOptions(options, flags);
  const cdp = flagString(flags, "cdp");
  const port = flagString(flags, "port");
  if (cdp || port) options.cdpBase = defaultCdpBase(port, cdp);

  const instructions = flagString(flags, "instructions");
  const instructionsFile = flagString(flags, "instructions-file");
  if (instructions && instructionsFile) {
    throw invalidArgs("Use only one instructions source.", ["Pass --instructions or --instructions-file, not both."]);
  }
  if (instructions) {
    options.instructions = await readMaybeAtFile(instructions, cwd);
  }
  if (instructionsFile) {
    options.instructions = await readFile(new URL(instructionsFile, `file://${cwd}/`), "utf8");
  }
  return options;
}

const SUBMIT_FLAGS = new Set([
  "json",
  "no-json",
  "model",
  "reasoning",
  "verbosity",
  "reasoning-summary",
  "tool-choice",
  "parallel-tools",
  "instructions",
  "instructions-file",
  "timeout",
  "retries",
  "retry-delay",
  "store",
  "save",
  "temporary",
  "no-temporary",
  "conversation",
  "parent",
  "no-start",
  "cdp",
  "port",
]);

function setConversationOptions(
  options: Record<string, unknown>,
  flags: Map<string, string | boolean | string[]>,
): void {
  const conversationId = flagString(flags, "conversation");
  const parentMessageId = flagString(flags, "parent");
  if (conversationId || parentMessageId) {
    if (!conversationId || !parentMessageId) {
      throw invalidArgs("Continuing a conversation needs both ids.", [
        "Use --conversation <conversation-id> --parent <message-id>.",
      ]);
    }
    options.conversationId = conversationId;
    options.parentMessageId = parentMessageId;
  }

  const store = readBooleanFlag(flags, "store");
  const save = flagBoolean(flags, "save") || flagBoolean(flags, "no-temporary") || store === true;
  const temporary = flagBoolean(flags, "temporary") || store === false;
  if (save && temporary) {
    throw invalidArgs("Choose either temporary or saved chat mode.", [
      "Use --temporary for a temporary chat or --save for a saved conversation.",
    ]);
  }

  options.temporary = temporary || (!save && !conversationId);
}

function resolveReasoning(reasoning: string): string {
  if (REASONING_LEVELS.includes(reasoning)) return reasoning;
  throw invalidArgs("Invalid --reasoning.", [`Allowed values: ${REASONING_LEVELS.join(", ")}.`]);
}

function rejectUnsupportedFlags(
  flags: Map<string, string | boolean | string[]>,
  allowed: Set<string>,
  command: string,
): void {
  for (const key of flags.keys()) {
    if (!allowed.has(key)) {
      throw invalidArgs(`Unsupported --${key} for ${command}.`, [
        "Run pro help or pro models --json for supported request controls.",
      ]);
    }
  }
}

async function executeQueuedJob(
  store: JobStore,
  jobId: string,
  paths: ReturnType<typeof resolvePaths>,
): Promise<Record<string, unknown>> {
  const claimed = store.claimQueued(jobId);
  if (!claimed) return { job: redactJob(store.get(jobId)) };
  try {
    const result = await runChatGptJob(claimed, {
      sessionTokenPath: paths.sessionTokenPath,
      cdpBase: stringFromOption(claimed.options.cdpBase),
      timeoutMs: numberFromOption(claimed.options.timeoutMs),
      retries: numberFromOption(claimed.options.retries),
      retryDelayMs: numberFromOption(claimed.options.retryDelayMs),
    });
    const completed = store.markSucceeded(jobId, result);
    return { job: redactJob(completed), result };
  } catch (error) {
    const proError = toProError(error);
    return {
      job: redactJob(store.markFailed(jobId, proError)),
      error: proError.toPayload(),
    };
  }
}

function startBackgroundWorker(jobId: string, io: CliIO, home: string): void {
  const cliPath = new URL("./cli.ts", import.meta.url).pathname;
  const logDir = join(home, "workers");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = join(logDir, `${jobId}.log`);
  const env = { ...process.env };
  for (const [key, value] of Object.entries(io.env)) {
    if (value !== undefined) env[key] = value;
  }
  const logFd = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [cliPath, "worker", jobId, "--json"], {
    cwd: io.cwd,
    detached: true,
    env,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
}

async function waitForTerminalJob(
  store: JobStore,
  jobId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<ReturnType<JobStore["get"]>> {
  const start = Date.now();
  while (true) {
    const job = store.get(jobId);
    if (job.status !== "running") return job;
    if (timeoutMs > 0 && Date.now() - start >= timeoutMs) {
      throw new ProError("WAIT_TIMEOUT", `Job ${jobId} is still running.`, {
        exitCode: EXIT.timeout,
        suggestions: ["Run pro status <job-id> later.", "Use pro cancel <job-id> if this job is stale."],
      });
    }
    await sleep(pollMs);
  }
}

async function readMaybeAtFile(value: string, cwd: string): Promise<string> {
  if (value.startsWith("@") && !value.includes(" ")) {
    return readFile(new URL(value.slice(1), `file://${cwd}/`), "utf8");
  }
  return value;
}

function setStringOption(
  options: Record<string, unknown>,
  target: string,
  flags: Map<string, string | boolean | string[]>,
  source: string,
  allowed?: string[],
): void {
  const value = flagString(flags, source);
  if (value === undefined) return;
  if (allowed && !allowed.includes(value)) {
    throw invalidArgs(`Invalid --${source}.`, [`Allowed values: ${allowed.join(", ")}.`]);
  }
  options[target] = value;
}

function setIntegerOption(
  options: Record<string, unknown>,
  target: string,
  flags: Map<string, string | boolean | string[]>,
  source: string,
  min: number,
  max: number,
): void {
  const value = flagString(flags, source);
  if (value === undefined) return;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw invalidArgs(`Invalid --${source}.`, [`Use an integer between ${min} and ${max}.`]);
  }
  options[target] = number;
}

function setBooleanOption(
  options: Record<string, unknown>,
  target: string,
  flags: Map<string, string | boolean | string[]>,
  source: string,
): void {
  const parsed = readBooleanFlag(flags, source);
  if (parsed === undefined) return;
  options[target] = parsed;
}

function readBooleanFlag(
  flags: Map<string, string | boolean | string[]>,
  source: string,
): boolean | undefined {
  const value = flagString(flags, source);
  if (value === undefined) return undefined;
  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }
  throw invalidArgs(`Invalid --${source}.`, ["Use true or false."]);
}

function parseIntegerFlag(
  flags: Map<string, string | boolean | string[]>,
  source: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = flagString(flags, source);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw invalidArgs(`Invalid --${source}.`, [`Use an integer between ${min} and ${max}.`]);
  }
  return number;
}

function numberFromOption(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringFromOption(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function windowsQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
