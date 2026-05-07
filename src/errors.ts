export const EXIT = {
  success: 0,
  notFound: 1,
  invalidArgs: 2,
  auth: 3,
  upstream: 4,
  network: 5,
  timeout: 6,
  internal: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface ErrorPayload {
  code: string;
  message: string;
  suggestions: string[];
  details?: Record<string, unknown>;
}

export class ProError extends Error {
  readonly code: string;
  readonly suggestions: string[];
  readonly exitCode: ExitCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: {
      suggestions?: string[];
      exitCode?: ExitCode;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProError";
    this.code = code;
    this.suggestions = options.suggestions ?? [];
    this.exitCode = options.exitCode ?? EXIT.internal;
    this.details = options.details;
  }

  toPayload(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      suggestions: this.suggestions,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function toProError(error: unknown): ProError {
  if (error instanceof ProError) return error;
  if (error instanceof Error) {
    return new ProError("INTERNAL_ERROR", error.message, {
      exitCode: EXIT.internal,
      suggestions: ["Run with --json and inspect the structured error."],
      cause: error,
    });
  }
  return new ProError("INTERNAL_ERROR", String(error), {
    exitCode: EXIT.internal,
    suggestions: ["Run with --json and inspect the structured error."],
  });
}
