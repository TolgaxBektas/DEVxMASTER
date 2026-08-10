import { describe, expect, it } from "vitest";
import { MemoryQueueRepository } from "./memory-repository.js";
import { LeaseQueue } from "./queue.js";
import { retryDelay } from "./backoff.js";

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
});
