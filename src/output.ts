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
  if (
    payload &&
    typeof payload === "object" &&
    "text" in payload &&
    typeof payload.text === "string"
  ) {
    return payload.text;
  }
  return JSON.stringify(payload);
}
