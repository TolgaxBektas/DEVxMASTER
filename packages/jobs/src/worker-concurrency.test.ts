import { describe, expect, it } from "vitest";
import { MemoryQueueRepository } from "./memory-repository.js";
import { LeaseQueue } from "./queue.js";
import { Worker } from "./worker.js";

describe("Worker concurrency", () => {
  it("führt wartende Jobs mit mehreren Läufen genau einmal parallel aus", async () => {
    const repository = new MemoryQueueRepository();
    const queue = new LeaseQueue(repository);
    const jobs = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        queue.enqueue({ name: "parallel", payload: { index } }),
      ),
    );
    let entered = 0;
    let completed = 0;
    let releaseAll!: () => void;
    let resolveBothEntered!: () => void;
    let resolveAllCompleted!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      resolveBothEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const allCompleted = new Promise<void>((resolve) => {
      resolveAllCompleted = resolve;
    });
    const handlers = new Map([
      [
        "parallel",
        {
          name: "parallel",
          handle: async () => {
            entered += 1;
            if (entered === 2) resolveBothEntered();
            await released;
            completed += 1;
            if (completed === jobs.length) resolveAllCompleted();
          },
        },
      ],
    ]);
    const worker = new Worker(queue, handlers);
    const controllers = [new AbortController(), new AbortController()];
    const runs = controllers.map((controller, index) =>
      worker.run({
        workerId: `test-worker-${index}`,
        pollMs: 1,
        signal: controller.signal,
      }),
    );
    let timeout!: ReturnType<typeof setTimeout>;

    try {
      await Promise.race([
        bothEntered,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Jobs liefen nicht parallel")),
            1_000,
          );
        }),
      ]);
      clearTimeout(timeout);
      expect(entered).toBe(2);
      releaseAll();
      await allCompleted;
    } finally {
      clearTimeout(timeout);
      releaseAll?.();
      controllers.forEach((controller) => controller.abort());
      worker.stop();
      await Promise.allSettled(runs);
    }

    expect(completed).toBe(jobs.length);
    for (const job of jobs) {
      expect(await repository.get(job.id)).toMatchObject({
        status: "completed",
        attempts: 1,
      });
    }
  });
});
