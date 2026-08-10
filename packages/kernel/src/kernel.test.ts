import { describe, expect, it } from "vitest";
import {
  appendAudit,
  computeAuditHash,
  GENESIS_HASH,
  MemoryAuditRepository,
  verifyAuditChain,
  type AuditRepository,
} from "./audit.js";
import { createEventBus, MemoryEventRepository } from "./events.js";
import { createRegistry, defineModule } from "./module-registry.js";
import { can, PermissionRegistry, tenantScope } from "./rbac.js";
import { router } from "./trpc.js";

describe("Audit-Hashkette", () => {
  it("erkennt Manipulation und behandelt seq-Kollisionen mit Retry", async () => {
    const repository = new MemoryAuditRepository();
    repository.forceNextCollision();
    await appendAudit(repository, {
      tenantId: "tenant-a",
      action: "created",
      entityType: "invoice",
      entityId: 1,
    });
    await appendAudit(repository, {
      tenantId: "tenant-a",
      action: "sent",
      entityType: "invoice",
      entityId: 1,
    });
    expect((await verifyAuditChain(repository)).ok).toBe(true);
    repository.entries[1]!.tenantId = "tenant-b";
    expect((await verifyAuditChain(repository)).brokenAtSeq).toBe(2);
    repository.entries[1]!.tenantId = "tenant-a";
    repository.entries[1]!.createdAt = new Date("2000-01-01T00:00:00.000Z");
    expect((await verifyAuditChain(repository)).brokenAtSeq).toBe(2);
    expect(
      computeAuditHash({
        seq: 1,
        tenantId: "tenant-a",
        action: "created",
        entityType: "invoice",
        entityId: 1,
        prevHash: GENESIS_HASH,
        detailsJson: null,
        createdAt: repository.entries[0]!.createdAt,
      }),
    ).toHaveLength(64);
    const normalized = {
      seq: 1,
      tenantId: "tenant-a",
      action: "created",
      entityType: "invoice",
      prevHash: GENESIS_HASH,
      detailsJson: null,
      createdAt: repository.entries[0]!.createdAt,
    };
    expect(computeAuditHash({ ...normalized, entityId: 1 })).toBe(
      computeAuditHash({ ...normalized, entityId: "1" }),
    );
  });

  it("vergibt bei parallelen Schreibern lückenlose Sequenzen", async () => {
    const repository = new MemoryAuditRepository();
    let latestCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const concurrent: AuditRepository = {
      latest: async () => {
        latestCalls += 1;
        if (latestCalls === 2) release();
        if (latestCalls <= 2) await gate;
        return repository.entries.at(-1) ?? null;
      },
      insert: (entry) => repository.insert(entry),
      list: (tenantId) => repository.list(tenantId),
    };
    await Promise.all([
      appendAudit(concurrent, { tenantId: "1", action: "a", entityType: "x" }, {
        sleep: async () => undefined,
      }),
      appendAudit(concurrent, { tenantId: "2", action: "b", entityType: "x" }, {
        sleep: async () => undefined,
      }),
    ]);
    expect(repository.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect((await verifyAuditChain(repository)).ok).toBe(true);
  });

  it("wertet den MySQL-Duplikatcode aus und liest den Vorgänger erneut", async () => {
    const repository = new MemoryAuditRepository();
    let collisions = 0;
    const retrying: AuditRepository = {
      latest: () => repository.latest(),
      insert: async (entry) => {
        if (collisions++ === 0) {
          const cause = new Error("duplicate");
          Object.assign(cause, { errno: 1062 });
          const error = new Error("DrizzleQueryError", { cause });
          throw error;
        }
        await repository.insert(entry);
      },
      list: (tenantId) => repository.list(tenantId),
    };
    const waits: number[] = [];
    const entry = await appendAudit(
      retrying,
      { tenantId: "1", action: "retry", entityType: "test" },
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
        random: () => 0.5,
      },
    );
    expect(entry.seq).toBe(1);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(25);
  });

  it("prüft einen Mandantenausschnitt ohne fremde Ketteneinträge", async () => {
    const repository = new MemoryAuditRepository();
    await appendAudit(repository, { tenantId: "1", action: "a", entityType: "x" });
    await appendAudit(repository, { tenantId: "2", action: "b", entityType: "x" });
    await appendAudit(repository, { tenantId: "1", action: "c", entityType: "x" });
    const result = await verifyAuditChain(repository, "1");
    expect(result).toMatchObject({
      ok: true,
      totalEntries: 2,
      scoped: true,
      complete: false,
    });
  });
});

describe("RBAC und Modulregister", () => {
  it("prüft Rechte und Mandantengrenzen", () => {
    const context = {
      tenantId: "t1",
      permissions: new Set(["billing.invoice.issue"]),
    } as any;
    expect(can(context, "billing.invoice.issue")).toBe(true);
    expect(can(context, "billing.invoice.issue", "t2")).toBe(false);
    expect(tenantScope(context).tenantId).toBe("t1");
    const registry = new PermissionRegistry();
    registry.register([{ permission: "billing.invoice.issue" }]);
    expect(() =>
      registry.register([{ permission: "billing.invoice.issue" }]),
    ).toThrow();
  });
  it("komponiert Module und verwirft Kollisionen", async () => {
    const module = (id: string) =>
      defineModule({
        id,
        title: id,
        icon: "box",
        version: "1.0.0",
        schema: {},
        router: router({}),
        nav: [{ id: `${id}.home`, label: id, href: `/${id}` }],
        pages: [],
        permissions: [{ permission: `${id}.read` }],
        jobs: [],
        events: [],
        health: () => ({ id, status: "healthy" }),
      });
    expect(
      (await import("./module-registry.js")).createRegistry([module("crm")])
        .modules,
    ).toHaveLength(1);
    expect(() => createRegistry([module("crm"), module("crm")])).toThrow();
  });
});

describe("Event-Outbox", () => {
  it("stellt mindestens einmal zu und kann idempotent konsumiert werden", async () => {
    const repository = new MemoryEventRepository();
    const seen = new Set<string>();
    let calls = 0;
    const bus = createEventBus(repository, [
      {
        name: "document.ingested",
        async handle(event) {
          if (!seen.has(event.id)) {
            seen.add(event.id);
            calls += 1;
          }
        },
      },
    ]);
    const event = await bus.publish({
      name: "document.ingested",
      tenantId: "t1",
      aggregateType: "document",
      aggregateId: "d1",
      payload: { ok: true },
      idempotencyKey: "doc:d1",
    });
    const duplicate = await bus.publish({
      name: "document.ingested",
      tenantId: "t1",
      aggregateType: "document",
      aggregateId: "d1",
      payload: { ok: true },
      idempotencyKey: "doc:d1",
    });
    expect(duplicate.id).toBe(event.id);
    expect(await bus.dispatch()).toBe(1);
    expect(await bus.dispatch()).toBe(0);
    expect(event.id).toBeTruthy();
    expect(calls).toBe(1);
  });

  it("isoliert fehlerhafte Handler und merkt erfolgreiche Handler", async () => {
    const repository = new MemoryEventRepository();
    let successfulCalls = 0;
    let poisonCalls = 0;
    const bus = createEventBus(
      repository,
      [
        {
          name: "x",
          async handle() {
            successfulCalls += 1;
          },
        },
        {
          name: "x",
          async handle() {
            poisonCalls += 1;
            throw new Error("poison");
          },
        },
        {
          name: "y",
          async handle() {
            successfulCalls += 1;
          },
        },
      ],
      { maxAttempts: 2, backoffMs: () => 0 },
    );
    await bus.publish({
      name: "x",
      tenantId: "t",
      aggregateType: "x",
      aggregateId: "1",
      payload: {},
      idempotencyKey: "x",
    });
    await bus.publish({
      name: "y",
      tenantId: "t",
      aggregateType: "y",
      aggregateId: "1",
      payload: {},
      idempotencyKey: "y",
    });
    expect(await bus.dispatch()).toBe(1);
    expect(successfulCalls).toBe(2);
    expect(poisonCalls).toBe(1);
    expect(await bus.dispatch()).toBe(0);
    expect(successfulCalls).toBe(2);
    expect(poisonCalls).toBe(2);
    expect(repository.events[0]!.delivery.deadLetter).toBe(true);
  });
  it("stellt Dead Letters nach Wiedervorlage erneut zu", async () => {
    const repository = new MemoryEventRepository();
    let calls = 0;
    const bus = createEventBus(
      repository,
      [
        {
          name: "retry",
          async handle() {
            calls += 1;
            if (calls === 1) throw new Error("kaputt");
          },
        },
      ],
      { maxAttempts: 1, backoffMs: () => 0 },
    );
    const event = await bus.publish({
      name: "retry",
      tenantId: "t",
      aggregateType: "x",
      aggregateId: "1",
      payload: {},
      idempotencyKey: "retry",
    });
    await bus.dispatch();
    expect((await repository.state(event.id)).deadLetter).toBe(true);
    await repository.requeue(event.id);
    expect((await repository.state(event.id)).attempts).toBe(0);
    expect(await bus.dispatch()).toBe(1);
    expect(calls).toBe(2);
  });
});
