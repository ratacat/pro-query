import { readFile } from "node:fs/promises";
import { EXIT, ProError } from "./errors";

export interface StructuredOptions {
  schema?: unknown;
  formatHint?: string;
  retries: number;
  runner: (prompt: string) => Promise<string>;
}

export interface StructuredAttempt {
  raw: string;
  error: string | null;
}

export interface StructuredResult {
  parsed: unknown;
  raw: string;
  attempts: StructuredAttempt[];
}

export async function runStructured(userPrompt: string, opts: StructuredOptions): Promise<StructuredResult> {
  if (!opts.schema && !opts.formatHint) {
    throw new ProError("STRUCTURED_NO_HINT", "Pass --schema or --format.", {
      exitCode: EXIT.invalidArgs,
    });
  }
  const baseInstructions = buildStructuredInstructions(opts.schema, opts.formatHint);
  const wrappedPrompt = `${userPrompt.trim()}\n\n${baseInstructions}`;

  const attempts: StructuredAttempt[] = [];
  let lastError = "no attempt yet";

  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    const promptToUse =
      attempt === 0
        ? wrappedPrompt
        : `${wrappedPrompt}\n\nPREVIOUS ATTEMPT FAILED. Your reply was:\n\n${attempts[attempts.length - 1].raw}\n\nReason: ${lastError}\n\nReply again with valid JSON. Output ONLY the JSON in a fenced \`\`\`json block.`;
    const raw = await opts.runner(promptToUse);
    try {
      const parsed = extractJsonFromResponse(raw);
      const validation = opts.schema ? validateLightly(parsed, opts.schema) : { ok: true as const };
      if (!validation.ok) {
        lastError = validation.reason ?? "schema validation failed";
        attempts.push({ raw, error: lastError });
        continue;
      }
      attempts.push({ raw, error: null });
      return { parsed, raw, attempts };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      attempts.push({ raw, error: lastError });
    }
  }

  throw new ProError("STRUCTURED_PARSE_FAILED", "Could not parse a valid JSON response.", {
    exitCode: EXIT.upstream,
    suggestions: [
      "Increase --schema-retries.",
      "Simplify the schema or use --format for a lighter hint.",
      "Re-run with --json to inspect raw responses.",
    ],
    details: { attempts, lastError },
  });
}

export function buildStructuredInstructions(schema: unknown, formatHint?: string): string {
  if (schema !== undefined && schema !== null) {
    const schemaJson = typeof schema === "string" ? schema : JSON.stringify(schema, null, 2);
    return [
      "Respond with JSON that matches this JSON Schema.",
      "Output exactly one fenced ```json block. No prose before or after.",
      "If a field is unknown, use null. Do not invent fields not in the schema.",
      "",
      "JSON Schema:",
      "```json",
      schemaJson,
      "```",
    ].join("\n");
  }
  if (formatHint) {
    return [
      "Respond with JSON matching this format description.",
      "Output exactly one fenced ```json block. No prose before or after.",
      "",
      "Format:",
      formatHint.trim(),
    ].join("\n");
  }
  throw new ProError("STRUCTURED_NO_HINT", "Either schema or formatHint is required.", {
    exitCode: EXIT.invalidArgs,
  });
}

export function extractJsonFromResponse(text: string): unknown {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  let candidate: string;
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  } else {
    const start = findFirstJsonStart(text);
    if (start === -1) throw new Error("No JSON object or array found in response.");
    candidate = extractBalanced(text, start);
  }
  return JSON.parse(candidate);
}

function findFirstJsonStart(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "{" || c === "[") return i;
  }
  return -1;
}

function extractBalanced(text: string, start: number): string {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("Unterminated JSON value in response.");
}

export function validateLightly(value: unknown, schema: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(schema)) return { ok: true };
  const type = schema.type;
  if (typeof type === "string") {
    if (type === "object" && !isRecord(value)) return { ok: false, reason: "Expected object at root." };
    if (type === "array" && !Array.isArray(value)) return { ok: false, reason: "Expected array at root." };
    if (type === "string" && typeof value !== "string") return { ok: false, reason: "Expected string at root." };
    if (type === "number" && typeof value !== "number") return { ok: false, reason: "Expected number at root." };
    if (type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
      return { ok: false, reason: "Expected integer at root." };
    }
    if (type === "boolean" && typeof value !== "boolean") return { ok: false, reason: "Expected boolean at root." };
  }
  if (type === "object" && isRecord(value) && Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key === "string" && !(key in value)) {
        return { ok: false, reason: `Missing required field: ${key}` };
      }
    }
  }
  return { ok: true };
}

export async function loadSchema(value: string, cwd: string): Promise<unknown> {
  const text =
    value.startsWith("@") && !value.includes(" ")
      ? await readFile(new URL(value.slice(1), `file://${cwd}/`), "utf8")
      : value;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProError("STRUCTURED_BAD_SCHEMA", "Could not parse --schema as JSON.", {
      exitCode: EXIT.invalidArgs,
      cause: error,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
