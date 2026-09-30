import { describe, expect, it, vi } from "vitest";
import { NonRetryableError } from "@xmaster-center/kernel";
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

  it("prüft die Lease unter Sperre und lehnt einen verdrängten Token ab", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const repository = new MemoryQueueRepository();
    const queue = new LeaseQueue(repository, {
      leaseMs: 10,
      now: () => now,
    });
    const created = await queue.enqueue({ name: "lease-lock", payload: {} });
    const firstClaim = await queue.claimNext("first");

    expect(firstClaim).not.toBeNull();
    expect(await queue.lockLease(firstClaim!)).toBe(true);

    now = new Date(now.getTime() + 11);
    const secondClaim = await queue.claimNext("second");

    expect(secondClaim?.id).toBe(created.id);
    expect(await queue.lockLease(firstClaim!)).toBe(false);
    expect(await queue.lockLease(secondClaim!)).toBe(true);
  });

  it("findet nur aktive Jobs mit passendem Namen, Mandanten und JSON-Feld", async () => {
    const repository = new MemoryQueueRepository();
    const queue = new LeaseQueue(repository);
    await queue.enqueue({
      name: "processing.run",
      tenantId: "1",
      payload: { documentId: 42 },
    });
    const processing = await queue.enqueue({
      name: "processing.run",
      tenantId: "1",
      payload: { documentId: 43 },
    });
    repository.jobs.set(processing.id, {
      ...processing,
      status: "processing",
      leaseToken: "lease",
      leaseExpiresAt: new Date(Date.now() + 10_000),
    });
    const completed = await queue.enqueue({
      name: "processing.run",
      tenantId: "1",
      payload: { documentId: 44 },
    });
    repository.jobs.set(completed.id, { ...completed, status: "completed" });
    const dead = await queue.enqueue({
      name: "processing.run",
      tenantId: "1",
      payload: { documentId: 45 },
    });
    repository.jobs.set(dead.id, { ...dead, status: "dead" });
    await queue.enqueue({
      name: "processing.run",
      tenantId: null,
      payload: { documentId: 46 },
    });

    const query = {
      name: "processing.run",
      tenantId: "1",
      payloadKey: "documentId",
    };
    expect(await queue.hasActiveJob({ ...query, payloadValue: 42 })).toBe(true);
    expect(await queue.hasActiveJob({ ...query, payloadValue: 43 })).toBe(true);
    expect(await queue.hasActiveJob({ ...query, payloadValue: 44 })).toBe(false);
    expect(await queue.hasActiveJob({ ...query, payloadValue: 45 })).toBe(false);
    expect(await queue.hasActiveJob({ ...query, payloadValue: 47 })).toBe(false);
    expect(
      await queue.hasActiveJob({ ...query, tenantId: "2", payloadValue: 42 }),
    ).toBe(false);
    expect(
      await queue.hasActiveJob({ ...query, tenantId: null, payloadValue: 46 }),
    ).toBe(true);
    await expect(
      queue.hasActiveJob({ ...query, payloadKey: "document-id", payloadValue: 42 }),
    ).rejects.toThrow("Invalid job payload key");
    await expect(
      queue.hasActiveJob({ ...query, tenantId: "tenant-1", payloadValue: 42 }),
    ).rejects.toThrow("Ungültige Mandanten-ID für Jobabfrage");
  });

  it("reicht den Transaktions-Executor beim Einreihen weiter", async () => {
    const repository = new MemoryQueueRepository();
    const insert = vi.spyOn(repository, "insert");
    const queue = new LeaseQueue(repository);
    const executor = { transaction: true };

    await queue.enqueue(
      { name: "transactional", payload: {} },
      executor,
    );

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "transactional" }),
      executor,
    );
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

  it("setzt nicht wiederholbare Fehler sofort auf dead", async () => {
    const repository = new MemoryQueueRepository();
    const queue = new LeaseQueue(repository);
    const created = await queue.enqueue({
      name: "permanent",
      payload: {},
      maxAttempts: 10,
    });
    const controller = new AbortController();
    let worker!: Worker;
    worker = new Worker(queue, new Map([[
      "permanent",
      {
        name: "permanent",
        handle: async () => {
          worker.stop();
          throw new NonRetryableError("http_404");
        },
      },
    ]]));
    await worker.run({ workerId: "test", signal: controller.signal });
    expect(await repository.get(created.id)).toMatchObject({
      status: "dead",
      attempts: 1,
      lastError: "http_404",
    });
  });

  it("wiederholt vorübergehende Fehler bis zum Erfolg", async () => {
    const repository = new MemoryQueueRepository();
    const queue = new LeaseQueue(repository, {
      backoff: { baseMs: 0, jitter: 0 },
    });
    const created = await queue.enqueue({
      name: "transient",
      payload: {},
      maxAttempts: 3,
    });
    const controller = new AbortController();
    let calls = 0;
    let worker!: Worker;
    worker = new Worker(queue, new Map([[
      "transient",
      {
        name: "transient",
        handle: async () => {
          calls += 1;
          if (calls === 1) throw new Error("timeout");
          worker.stop();
        },
      },
    ]]));
    await worker.run({ workerId: "test", signal: controller.signal });
    expect(await repository.get(created.id)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });
});
