import type { RuntimePaths } from "./config";
import { EXIT, ProError } from "./errors";
import { buildEphemeralJob, executeEphemeralJob } from "./executor";

export type AggregateMethod = "mean" | "median" | "trimmed-mean";

export interface OddsRunInput {
  question: string;
  context?: string;
  model: string;
  reasoning: string;
  samples: number;
  aggregate: AggregateMethod;
  allowFifty: boolean;
  parseRetries: number;
  baseRequestOptions: Record<string, unknown>;
  paths: RuntimePaths;
}

export interface OddsSampleAttempt {
  jobId: string;
  raw: string;
  parsed: number | null;
  rejectedFifty: boolean;
}

export interface OddsRunResult {
  probability: number;
  probabilityRaw: number;
  samples: number[];
  aggregate: AggregateMethod;
  parseFailures: number;
  rejectedFifties: number;
  attempts: OddsSampleAttempt[];
  jobIds: string[];
  model: string;
  reasoning: string;
  allowFifty: boolean;
}

export function buildOddsInstructions(allowFifty: boolean): string {
  const fiftyRule = allowFifty
    ? "If you have no information either way, output 50."
    : "Even with limited information you MUST commit to a directional estimate. Pick 49 or 51 over 50. Do NOT output 50.";
  return [
    "You are a calibrated probabilistic forecaster.",
    "You will receive a yes/no question and any supporting context.",
    "Read everything carefully and estimate the probability the question resolves YES.",
    "",
    "OUTPUT RULES (STRICT):",
    "- Output exactly one integer between 0 and 100.",
    "- No tags. No words. No punctuation. No explanation. No reasoning. No markdown. Nothing else.",
    "- Just the integer, on its own. Nothing before. Nothing after.",
    "- 0 means certain NO. 100 means certain YES.",
    `- ${fiftyRule}`,
  ].join("\n");
}

export function buildOddsPrompt(question: string, context?: string): string {
  const trimmedContext = context?.trim();
  const lines: string[] = [];
  if (trimmedContext) {
    lines.push("CONTEXT:", trimmedContext, "");
  }
  lines.push("QUESTION:", question.trim(), "", "Reply with a single integer between 0 and 100. Nothing else.");
  return lines.join("\n");
}

const STRICT_INTEGER = /^\s*(\d{1,3})\s*$/;
const FIRST_INTEGER = /(?:^|[^\w.-])(\d{1,3})(?!\w|[.]\d)/;

export function parseOddsResponse(
  text: string,
  allowFifty: boolean,
): { value: number | null; rejectedFifty: boolean } {
  let candidate: number | null = null;
  const strict = STRICT_INTEGER.exec(text);
  if (strict) {
    const n = Number(strict[1]);
    if (Number.isInteger(n) && n >= 0 && n <= 100) candidate = n;
  } else {
    const loose = FIRST_INTEGER.exec(text);
    if (loose) {
      const n = Number(loose[1]);
      if (Number.isInteger(n) && n >= 0 && n <= 100) candidate = n;
    }
  }
  if (candidate === null) return { value: null, rejectedFifty: false };
  if (!allowFifty && candidate === 50) return { value: null, rejectedFifty: true };
  return { value: candidate, rejectedFifty: false };
}

export function aggregateOdds(values: number[], method: AggregateMethod): number {
  if (values.length === 0) {
    throw new ProError("ODDS_NO_SAMPLES", "No valid samples to aggregate.", {
      exitCode: EXIT.internal,
    });
  }
  if (method === "median") {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
  if (method === "trimmed-mean") {
    if (values.length < 4) return mean(values);
    const sorted = [...values].sort((a, b) => a - b);
    const trim = Math.max(1, Math.floor(values.length * 0.1));
    return mean(sorted.slice(trim, sorted.length - trim));
  }
  return mean(values);
}

function mean(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

export async function runOdds(input: OddsRunInput): Promise<OddsRunResult> {
  const instructions = buildOddsInstructions(input.allowFifty);
  const prompt = buildOddsPrompt(input.question, input.context);

  const requestOptions: Record<string, unknown> = {
    ...input.baseRequestOptions,
    instructions,
  };
  if (requestOptions.temporary === undefined) requestOptions.temporary = true;

  const attempts: OddsSampleAttempt[] = [];
  const samples: number[] = [];
  const jobIds: string[] = [];
  let parseFailures = 0;
  let rejectedFifties = 0;

  for (let i = 0; i < input.samples; i += 1) {
    let parsed: number | null = null;
    let rejectedFifty = false;
    let lastJobId = "";
    let lastRaw = "";
    for (let attempt = 0; attempt <= input.parseRetries; attempt += 1) {
      const job = buildEphemeralJob({
        prompt,
        model: input.model,
        reasoning: input.reasoning,
        options: requestOptions,
      });
      const outcome = await executeEphemeralJob(job, input.paths);
      const jobObj = isRecord(outcome.job) ? outcome.job : {};
      lastJobId = typeof jobObj.id === "string" ? jobObj.id : job.id;
      lastRaw = typeof outcome.result === "string" ? outcome.result : "";
      if (isRecord(outcome.error)) {
        throw new ProError(
          stringField(outcome.error, "code") ?? "ODDS_UPSTREAM_FAILED",
          stringField(outcome.error, "message") ?? "ChatGPT request failed.",
          {
            exitCode: EXIT.upstream,
            suggestions: ["Run pro-cli doctor --json or retry with fewer --samples."],
            details: { jobId: lastJobId, sampleIndex: i, attempt },
          },
        );
      }
      const parseResult = parseOddsResponse(lastRaw, input.allowFifty);
      if (parseResult.value !== null) {
        parsed = parseResult.value;
        rejectedFifty = false;
        break;
      }
      if (parseResult.rejectedFifty) {
        rejectedFifty = true;
        rejectedFifties += 1;
      } else {
        parseFailures += 1;
      }
    }
    attempts.push({ jobId: lastJobId, raw: lastRaw, parsed, rejectedFifty });
    jobIds.push(lastJobId);
    if (parsed !== null) samples.push(parsed);
  }

  if (samples.length === 0) {
    throw new ProError("ODDS_PARSE_FAILED", "Could not extract a probability from any sample.", {
      exitCode: EXIT.upstream,
      suggestions: [
        "Re-run with --json to inspect raw responses.",
        "Increase --parse-retries or --samples.",
        "If 50 was the only response, pass --allow-fifty.",
      ],
      details: { attempts, requestedSamples: input.samples },
    });
  }

  const probabilityRaw = aggregateOdds(samples, input.aggregate);
  const probability = Math.max(0, Math.min(100, Math.round(probabilityRaw)));

  return {
    probability,
    probabilityRaw,
    samples,
    aggregate: input.aggregate,
    parseFailures,
    rejectedFifties,
    attempts,
    jobIds,
    model: input.model,
    reasoning: input.reasoning,
    allowFifty: input.allowFifty,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  return typeof v === "string" ? v : undefined;
}
