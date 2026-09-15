import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryQueueRepository } from "./memory-repository.js";
import { LeaseQueue } from "./queue.js";
import { Worker } from "./worker.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Worker-Leases", () => {
  it("hält eine laufende Verarbeitung per Herzschlag", async () => {
    vi.useFakeTimers();
    const repository = new MemoryQueueRepository();
    const queue = new LeaseQueue(repository, { leaseMs: 3_000 });
    const created = await queue.enqueue({ name: "long", payload: {} });
    let start!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let worker!: Worker;
    worker = new Worker(queue, new Map([
      ["long", {
        name: "long",
        handle: async () => {
          start();
          await finished;
          worker.stop();
        },
      }],
    ]));

    const run = worker.run({ workerId: "first", pollMs: 1 });
    await started;
    await vi.advanceTimersByTimeAsync(3_001);

    expect(await queue.claimNext("second")).toBeNull();
    finish();
    await run;

    expect(await repository.get(created.id)).toMatchObject({
      status: "completed",
      attempts: 1,
    });
  });

  it("bricht bei verlorenem Lease ab und schreibt den Jobstatus nicht", async () => {
    vi.useFakeTimers();
    const repository = new MemoryQueueRepository();
    const queue = new LeaseQueue(repository, { leaseMs: 3_000 });
    const created = await queue.enqueue({ name: "lost", payload: {} });
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let worker!: Worker;
    worker = new Worker(queue, new Map([
      ["lost", {
        name: "lost",
        handle: async (_payload, context) => {
          start();
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          worker.stop();
        },
      }],
    ]));

    const run = worker.run({ workerId: "first", pollMs: 1 });
    await started;
    const secondClaim = await repository.claim(
      new Date(Date.now() + 3_001),
      queue.leaseMs,
    );
    expect(secondClaim?.id).toBe(created.id);
    await vi.advanceTimersByTimeAsync(1_001);
    await run;

    expect(await repository.get(created.id)).toMatchObject({
      status: "processing",
      attempts: 2,
      leaseToken: secondClaim?.leaseToken,
    });
  });

  it("behandelt einen Fehler bei gehaltener Lease unverändert", async () => {
    const repository = new MemoryQueueRepository();
    const queue = new LeaseQueue(repository, { backoff: { baseMs: 0, jitter: 0 } });
    const created = await queue.enqueue({
      name: "failing",
      payload: {},
      maxAttempts: 1,
    });
    let worker!: Worker;
    worker = new Worker(queue, new Map([
      ["failing", {
        name: "failing",
        handle: async () => {
          worker.stop();
          throw new Error("dauerhaft fehlgeschlagen");
        },
      }],
    ]));

    await worker.run({ workerId: "test" });

    expect(await repository.get(created.id)).toMatchObject({
      status: "dead",
      attempts: 1,
      lastError: "dauerhaft fehlgeschlagen",
    });
  });
});
