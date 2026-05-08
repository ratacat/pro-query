import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { ProError } from "../src/errors";
import { waitForJob, waitForTerminalJob } from "../src/executor";
import { JobStore } from "../src/jobs";

async function withStore<T>(fn: (store: JobStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pro-executor-test-"));
  const store = await JobStore.open(join(dir, "jobs.sqlite"));
  try {
    return await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("job waiting", () => {
  test("soft wait returns current job state when the timeout expires", async () => {
    await withStore(async (store) => {
      const created = store.create({
        prompt: "large prompt",
        model: "gpt-5-5-pro",
        reasoning: "extended",
        options: {},
      });

      const outcome = await waitForJob(store, created.id, 1, 25);

      expect(outcome.timedOut).toBe(true);
      expect(outcome.status).toBe("queued");
      expect(outcome.job.id).toBe(created.id);
      expect(outcome.elapsedMs).toBeGreaterThanOrEqual(1);
      expect(outcome.timeoutMs).toBe(1);
      expect(outcome.pollMs).toBe(25);
    });
  });

  test("hard wait timeout includes current status and retry guidance", async () => {
    await withStore(async (store) => {
      const created = store.create({
        prompt: "large prompt",
        model: "gpt-5-5-pro",
        reasoning: "extended",
        options: {},
      });

      try {
        await waitForTerminalJob(store, created.id, 1, 25);
        throw new Error("Expected wait timeout.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        const proError = error as ProError;
        expect(proError.code).toBe("WAIT_TIMEOUT");
        expect(proError.message).toContain("still queued");
        expect(proError.suggestions[0]).toContain(`pro-cli job wait ${created.id} --json`);
        expect(proError.details?.status).toBe("queued");
        expect(proError.details?.timeoutMs).toBe(1);
      }
    });
  });
});
