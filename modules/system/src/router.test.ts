import { describe, expect, it } from "vitest";
import type { AuthContext } from "@xmaster-center/contracts";
import {
  MemoryAuditRepository,
  MemoryEventRepository,
} from "@xmaster-center/kernel";
import type { EventEnvelope as ContractEventEnvelope } from "@xmaster-center/contracts";
import { LeaseQueue } from "@xmaster-center/jobs";
import { MemoryQueueRepository } from "@xmaster-center/jobs";
import { createSystemRouter } from "./router.js";

const jobId = "10000000-0000-4000-8000-000000000001";
const eventId = "10000000-0000-4000-8000-000000000002";

function setup() {
  const audit = new MemoryAuditRepository();
  const events = new MemoryEventRepository();
  const queueRepository = new MemoryQueueRepository();
  const queue = new LeaseQueue(queueRepository);
  const job = {
    id: jobId,
    tenantId: 1,
    name: "test",
    payload: {},
    status: "dead" as const,
    attempts: 1,
    maxAttempts: 1,
    availableAt: new Date(),
    leaseToken: null,
    leaseExpiresAt: null,
    lastError: "kaputt",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const event: ContractEventEnvelope = {
    id: eventId,
    name: "test",
    tenantId: "1",
    aggregateType: "test",
    aggregateId: "1",
    payload: {},
    idempotencyKey: "test:1",
    occurredAt: new Date(),
  };
  let dbRows: unknown[] = [job];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => dbRows,
        }),
      }),
    }),
  };
  const context: AuthContext = {
    user: { id: "1", email: null, displayName: "Admin" },
    tenantId: "1",
    permissions: new Set([
      "system.health.read",
      "system.jobs.read",
      "system.jobs.requeue",
      "system.events.read",
      "system.events.requeue",
    ]),
    provider: "local",
  };
  queueRepository.jobs.set(jobId, { ...job, tenantId: "1" });
  return {
    audit,
    events,
    queue,
    queueRepository,
    context,
    job,
    event,
    db,
    get dbRows() {
      return dbRows;
    },
    set dbRows(value: unknown[]) {
      dbRows = value;
    },
    caller: createSystemRouter({
      db,
      audit,
      events,
      queue,
      health: async () => [],
      navigation: () => [],
    }).createCaller({ auth: context }),
  };
}

describe("System-Wiedervorlage", () => {
  it("prüft eigene Rechte und den Mandanten beim Job", async () => {
    const setupResult = setup();
    await setupResult.queue.enqueue({
      name: "test",
      payload: {},
      tenantId: "1",
    });
    setupResult.context.permissions = new Set(["system.jobs.read"]);
    await expect(
      setupResult.caller.jobs.requeue({ id: jobId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    setupResult.context.permissions = new Set(["system.jobs.requeue"]);
    setupResult.dbRows = [{ ...setupResult.job, tenantId: 2 }];
    await expect(
      setupResult.caller.jobs.requeue({ id: jobId }),
    ).rejects.toThrow("Job nicht gefunden");
  });

  it("weist laufende und abgeschlossene Jobs zurück", async () => {
    const setupResult = setup();
    setupResult.dbRows = [{ ...setupResult.job, status: "processing" }];
    setupResult.queueRepository.jobs.set(jobId, {
      ...setupResult.job,
      tenantId: "1",
      status: "processing",
    });
    await expect(
      setupResult.caller.jobs.requeue({ id: jobId }),
    ).rejects.toThrow("Nur tote Jobs");
  });

  it("prüft Event-Rechte, Mandant und veröffentlichten Zustand", async () => {
    const setupResult = setup();
    await setupResult.events.append(setupResult.event);
    await setupResult.events.markPublished(eventId);
    setupResult.context.permissions = new Set(["system.events.read"]);
    await expect(
      setupResult.caller.events.requeue({ id: eventId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    setupResult.context.permissions = new Set(["system.events.requeue"]);
    setupResult.dbRows = [];
    await expect(
      setupResult.caller.events.requeue({ id: eventId }),
    ).rejects.toThrow("Event nicht gefunden");
    setupResult.dbRows = [{ tenantId: 1 }];
    await expect(
      setupResult.caller.events.requeue({ id: eventId }),
    ).rejects.toThrow("Nur Dead Letters");
  });
});

describe("System-Mandantengrenzen", () => {
  it("liefert im Audit nur Einträge des aufrufenden Mandanten", async () => {
    let whereCalls = 0;
    const tenantRows = [{ seq: 2, tenantId: 2, action: "eigene" }];
    const builder = {
      from() { return this; },
      where() { whereCalls += 1; return this; },
      orderBy() { return this; },
      limit() { return Promise.resolve(tenantRows); },
    };
    const auth: AuthContext = {
      user: { id: "2", email: null, displayName: "Mandant 2" },
      tenantId: "2",
      permissions: new Set(["system.audit.read"]),
      provider: "local",
    };
    const caller = createSystemRouter({
      db: { select: () => builder } as never,
      audit: new MemoryAuditRepository(),
      events: new MemoryEventRepository(),
      queue: {} as never,
      health: async () => [],
      navigation: () => [],
    }).createCaller({ auth });
    expect(await caller.audit.list()).toEqual(tenantRows);
    expect(whereCalls).toBe(1);
  });
});
