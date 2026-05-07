import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { JobStore } from "../src/jobs";

async function withStore<T>(fn: (store: JobStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pro-jobs-test-"));
  const store = await JobStore.open(join(dir, "jobs.sqlite"));
  try {
    return await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("job store", () => {
  test("late worker success does not overwrite cancellation", async () => {
    await withStore(async (store) => {
      const created = store.create({
        prompt: "hello",
        model: "auto",
        reasoning: "low",
        options: {},
      });

      store.markRunning(created.id);
      store.cancel(created.id);
      store.markSucceeded(created.id, "late result");

      const job = store.get(created.id);
      expect(job.status).toBe("cancelled");
      expect(job.result).toBeNull();
    });
  });
});
