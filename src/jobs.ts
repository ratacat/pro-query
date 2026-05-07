import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { EXIT, ProError } from "./errors";
import { ensurePrivateDir } from "./config";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface SubmitJobInput {
  prompt: string;
  model: string;
  reasoning: string;
  options: Record<string, unknown>;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  prompt: string;
  model: string;
  reasoning: string;
  options: Record<string, unknown>;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  status: JobStatus;
  prompt: string;
  model: string;
  reasoning: string;
  options_json: string;
  result: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

export class JobStore {
  private constructor(private readonly db: Database) {}

  static async open(path: string): Promise<JobStore> {
    await ensurePrivateDir(dirname(path));
    const db = new Database(path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        options_json TEXT NOT NULL,
        result TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    return new JobStore(db);
  }

  create(input: SubmitJobInput): JobRecord {
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: `job_${randomUUID()}`,
      status: "queued",
      prompt: input.prompt,
      model: input.model,
      reasoning: input.reasoning,
      options: input.options,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        `INSERT INTO jobs
          (id, status, prompt, model, reasoning, options_json, result, error_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.status,
        job.prompt,
        job.model,
        job.reasoning,
        JSON.stringify(job.options),
        job.result,
        job.error,
        job.createdAt,
        job.updatedAt,
      );
    return redactJob(job);
  }

  get(id: string): JobRecord {
    const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
    if (!row) {
      throw new ProError("JOB_NOT_FOUND", `No job exists for ${id}.`, {
        exitCode: EXIT.notFound,
        suggestions: ["Run pro jobs --json to list recent jobs."],
      });
    }
    return rowToJob(row);
  }

  list(limit: number): JobRecord[] {
    const rows = this.db
      .query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as JobRow[];
    return rows.map(rowToJob).map(redactJob);
  }

  cancel(id: string): JobRecord {
    const job = this.get(id);
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return redactJob(job);
    }
    this.update(id, {
      status: "cancelled",
      error: JSON.stringify({
        code: "CANCELLED",
        message: "Job was cancelled before completion.",
      }),
    });
    return redactJob(this.get(id));
  }

  markRunning(id: string): JobRecord {
    this.update(id, { status: "running" });
    return this.get(id);
  }

  claimQueued(id: string): JobRecord | null {
    const now = new Date().toISOString();
    const result = this.db
      .query("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run("running", now, id, "queued") as { changes?: number };
    return result.changes && result.changes > 0 ? this.get(id) : null;
  }

  markSucceeded(id: string, result: string): JobRecord {
    this.update(id, { status: "succeeded", result, error: null });
    return this.get(id);
  }

  markFailed(id: string, error: ProError): JobRecord {
    this.update(id, {
      status: "failed",
      error: JSON.stringify(error.toPayload()),
    });
    return this.get(id);
  }

  close(): void {
    this.db.close();
  }

  private update(
    id: string,
    patch: { status?: JobStatus; result?: string | null; error?: string | null },
  ): void {
    const job = this.get(id);
    const next = {
      status: patch.status ?? job.status,
      result: patch.result === undefined ? job.result : patch.result,
      error: patch.error === undefined ? job.error : patch.error,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .query("UPDATE jobs SET status = ?, result = ?, error_json = ?, updated_at = ? WHERE id = ?")
      .run(next.status, next.result, next.error, next.updatedAt, id);
  }
}

export function redactJob(
  job: JobRecord,
): Omit<JobRecord, "result"> & { result: null; promptPreview: string; resultPreview?: string; hasResult: boolean } {
  return {
    ...job,
    prompt: "",
    result: null,
    promptPreview: compact(job.prompt, 160),
    ...(job.result ? { resultPreview: compact(job.result, 240) } : {}),
    hasResult: Boolean(job.result),
  };
}

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    status: row.status,
    prompt: row.prompt,
    model: row.model,
    reasoning: row.reasoning,
    options: JSON.parse(row.options_json) as Record<string, unknown>,
    result: row.result,
    error: row.error_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compact(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}
