import { describe, expect, it } from "vitest";
import {
  appendAudit,
  computeAuditHash,
  GENESIS_HASH,
  MemoryAuditRepository,
  verifyAuditChain,
} from "./audit.js";
import { createEventBus, MemoryEventRepository } from "./events.js";
import { createRegistry, defineModule } from "./module-registry.js";
import { can, PermissionRegistry, tenantScope } from "./rbac.js";

describe("Audit-Hashkette", () => {
  it("erkennt Manipulation und behandelt seq-Kollisionen mit Retry", async () => {
    const repository = new MemoryAuditRepository();
    repository.forceNextCollision();
    await appendAudit(repository, {
      action: "created",
      entityType: "invoice",
      entityId: 1,
    });
    await appendAudit(repository, {
      action: "sent",
      entityType: "invoice",
      entityId: 1,
    });
    expect((await verifyAuditChain(repository)).ok).toBe(true);
    repository.entries[1]!.hash = "tampered";
    expect((await verifyAuditChain(repository)).brokenAtSeq).toBe(2);
    expect(
      computeAuditHash({
        seq: 1,
        action: "created",
        entityType: "invoice",
        entityId: 1,
        prevHash: GENESIS_HASH,
        detailsJson: null,
      }),
    ).toHaveLength(64);
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
        router: {},
        nav: [{ id: `${id}.home`, label: id, href: `/${id}` }],
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
    expect(await bus.dispatch()).toBe(1);
    expect(await bus.dispatch()).toBe(0);
    expect(event.id).toBeTruthy();
    expect(calls).toBe(1);
  });
});
