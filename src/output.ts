import { ProError } from "./errors";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdoutIsTTY: boolean;
  env: Record<string, string | undefined>;
  cwd: string;
}

export interface OutputMode {
  json: boolean;
}

export function writeSuccess(io: CliIO, mode: OutputMode, payload: unknown): void {
  if (mode.json) {
    io.stdout(`${JSON.stringify({ ok: true, data: payload })}\n`);
    return;
  }
  io.stdout(`${renderText(payload)}\n`);
}

export function writeError(io: CliIO, mode: OutputMode, error: ProError): void {
  if (mode.json) {
    io.stderr(`${JSON.stringify({ ok: false, error: error.toPayload() })}\n`);
    return;
  }

  const suggestions =
    error.suggestions.length > 0 ? `\ntry: ${error.suggestions.join(" | ")}` : "";
  io.stderr(`${error.code}: ${error.message}${suggestions}\n`);
}

export function renderText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!isRecord(payload)) return JSON.stringify(payload);
  if (
    "text" in payload &&
    typeof payload.text === "string"
  ) {
    return payload.text;
  }
  if ("result" in payload && typeof payload.result === "string") {
    return payload.result;
  }
  if ("steps" in payload && Array.isArray(payload.steps)) {
    return renderSetup(payload);
  }
  if ("command" in payload && typeof payload.command === "string") {
    const capture =
      "captureCommand" in payload && typeof payload.captureCommand === "string"
        ? `\n\nThen capture:\n${payload.captureCommand}`
        : "";
    return `Open ChatGPT:\n${payload.command}${capture}`;
  }
  if ("ready" in payload && "next" in payload && isRecord(payload.next)) {
    const status = payload.ready ? "ready" : "not ready";
    const command =
      typeof payload.next.command === "string" ? `\nnext: ${payload.next.command}` : "";
    return `pro-cli ${status}${command}`;
  }
  if ("job" in payload && isRecord(payload.job)) {
    const id = typeof payload.job.id === "string" ? payload.job.id : "unknown";
    const status = typeof payload.job.status === "string" ? payload.job.status : "unknown";
    const resultHint =
      status === "succeeded" ? `\nresult: pro-cli result ${id}` : `\nwait: pro-cli wait ${id}`;
    return `job ${id} ${status}${resultHint}`;
  }
  return JSON.stringify(payload);
}

function renderSetup(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof payload.summary === "string") lines.push(payload.summary);
  const steps = payload.steps as unknown[];
  for (const step of steps) {
    if (!isRecord(step)) continue;
    const status = typeof step.status === "string" ? step.status : "todo";
    const id = typeof step.id === "string" ? step.id : "step";
    lines.push(`[${status}] ${id}`);
    if (typeof step.command === "string") lines.push(`  ${step.command}`);
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
