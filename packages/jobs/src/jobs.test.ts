import { describe, expect, it, vi } from "vitest";
import { MemoryQueueRepository } from "./memory-repository.js";
import { LeaseQueue } from "./queue.js";
import { retryDelay } from "./backoff.js";
import { Worker } from "./worker.js";

describe("Lease-Queue", () => {
  it("vergibt parallele Claims nur einmal", async () => {
    const repository = new MemoryQueueRepository();
    const queue = new LeaseQueue(repository);
    await queue.enqueue({ name: "test", payload: {} });
    const claims = await Promise.all([
      queue.claimNext("a"),
      queue.claimNext("b"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it("gibt abgelaufene Leases erneut frei und nutzt steigenden Backoff", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const repository = new MemoryQueueRepository();
    const queue = new LeaseQueue(repository, {
      leaseMs: 10,
      now: () => now,
      backoff: { baseMs: 100, jitter: 0 },
    });
    const created = await queue.enqueue({
      name: "test",
      payload: {},
      maxAttempts: 3,
    });
    const first = await queue.claimNext();
    expect(first).toBeTruthy();
    now = new Date(now.getTime() + 11);
    const second = await queue.claimNext();
    expect(second?.id).toBe(created.id);
    await queue.fail(second!, "retry");
    const failed = await repository.get(created.id);
    expect(failed?.status).toBe("pending");
    expect(failed?.availableAt.getTime()).toBe(now.getTime() + 200);
    expect(retryDelay(2, { baseMs: 100, jitter: 0 })).toBeGreaterThan(
      retryDelay(1, { baseMs: 100, jitter: 0 }),
    );
  });
  it("setzt tote Jobs bei der Wiedervorlage zurück", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const repository = new MemoryQueueRepository();
    const queue = new LeaseQueue(repository, { now: () => now });
    const created = await queue.enqueue({ name: "test", payload: {} });
    const claim = await queue.claimNext();
    await queue.fail(claim!, "kaputt", 1);
    const dead = await repository.get(created.id);
    expect(dead?.status).toBe("dead");
    const requeued = await queue.requeue(created.id);
    expect(requeued?.status).toBe("pending");
    expect(requeued?.attempts).toBe(0);
    expect(requeued?.lastError).toBeNull();
  });

  it("ruft bei einem endgültigen Fehler den Handler für die sichtbare Nachbearbeitung auf", async () => {
    const repository = new MemoryQueueRepository();
    const queue = new LeaseQueue(repository);
    await queue.enqueue({ name: "test", payload: { documentId: 7 }, maxAttempts: 1 });
    const failures: Array<{ tenantId: string | null; message: string }> = [];
    const worker = new Worker(queue, new Map([[
      "test",
      {
        name: "test",
        handle: async () => { throw new Error("dauerhaft fehlgeschlagen"); },
        onFailure: async (error, context) => {
          failures.push({
            tenantId: context.job.tenantId,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      },
    ]]));
    const controller = new AbortController();
    const run = worker.run({ workerId: "test", pollMs: 1, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    worker.stop();
    await run;
    expect(failures).toEqual([{ tenantId: null, message: "dauerhaft fehlgeschlagen" }]);
  });

  it("setzt die Arbeit nach einem Fehler in der Fehlerbehandlung fort", async () => {
    const repository = new MemoryQueueRepository();
    const queue = new LeaseQueue(repository);
    const first = await queue.enqueue({
      name: "failing",
      payload: {},
      maxAttempts: 1,
    });
    const second = await queue.enqueue({
      name: "next",
      payload: {},
      maxAttempts: 1,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = new Worker(queue, new Map([
      ["failing", {
        name: "failing",
        handle: async () => { throw new Error("job fehlgeschlagen"); },
        onFailure: async () => { throw new Error("fehlerbehandlung fehlgeschlagen"); },
      }],
      ["next", {
        name: "next",
        handle: async () => undefined,
      }],
    ]));
    const controller = new AbortController();
    const run = worker.run({ workerId: "test", pollMs: 1, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    worker.stop();
    await run;
    expect((await repository.get(first.id))?.status).toBe("dead");
    expect((await repository.get(second.id))?.status).toBe("completed");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
