import { describe, expect, it } from "vitest";
import type { AuthContext } from "@xmaster-center/contracts";
import {
  MemoryAuditRepository,
  MemoryEventRepository,
  createEventBus,
} from "@xmaster-center/kernel";
import type { CrmRepository } from "./repository.js";
import { createCrmRouter } from "./router.js";

function setup() {
  const audit = new MemoryAuditRepository();
  const eventRepository = new MemoryEventRepository();
  const eventBus = createEventBus(eventRepository, []);
  const rows = new Map<number, Record<string, unknown>>();
  const repository: CrmRepository = {
    async listCustomers(tenantId) {
      return [...rows.values()].filter(
        (row) => row.tenantId === Number(tenantId),
      );
    },
    async getCustomer(tenantId, id) {
      const row = rows.get(id);
      return row?.tenantId === Number(tenantId) ? row : null;
    },
    async createCustomer(tenantId, input) {
      const row = { ...input, id: rows.size + 1, tenantId: Number(tenantId) };
      rows.set(Number(row.id), row);
      return row;
    },
    async updateCustomer() {},
    async deleteCustomer() {},
    async listAddresses() {
      return [];
    },
    async createAddress() {
      return { id: 1 };
    },
    async listIndustries() {
      return [];
    },
    async listProjects() {
      return [];
    },
  };
  const deps = {
    repository,
    repositoryFor: () => repository,
    audit,
    auditFor: () => audit,
    transaction: <T>(callback: (db: unknown) => Promise<T>) => callback({}),
    eventExecutorFor: () => eventRepository,
    publish: (
      input: Parameters<typeof eventBus.publish>[0],
      executor = eventRepository,
    ) => eventBus.publish(input, executor),
  };
  const context: AuthContext = {
    user: { id: "7", email: "admin@example.invalid", displayName: "Admin" },
    tenantId: "1",
    permissions: new Set([
      "crm.customer.read",
      "crm.customer.write",
      "crm.address.read",
      "crm.address.write",
      "crm.industry.read",
      "crm.project.read",
    ]),
    provider: "local",
  };
  return {
    caller: createCrmRouter(deps).createCaller({ auth: context }),
    audit,
    eventRepository,
    context,
    rows,
  };
}

describe("CRM-Modulvertrag", () => {
  it("setzt Rechte durch und begrenzt den Tenant-Zugriff", async () => {
    const setupResult = setup();
    setupResult.context.permissions = new Set(["crm.customer.read"]);
    await expect(
      setupResult.caller.customers.create({ name: "Verweigert" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    setupResult.context.permissions = new Set([
      "crm.customer.read",
      "crm.customer.write",
    ]);
    await setupResult.caller.customers.create({ name: "Kunde" });
    expect(await setupResult.caller.customers.get({ id: 1 })).toMatchObject({
      tenantId: 1,
    });
    setupResult.context.tenantId = "2";
    expect(await setupResult.caller.customers.get({ id: 1 })).toBeNull();
  });

  it("schreibt beim Anlegen genau ein Audit und ein Event", async () => {
    const { caller, audit, eventRepository } = setup();
    await caller.customers.create({ name: "Audit-Kunde" });
    expect(audit.entries).toHaveLength(1);
    expect(eventRepository.events).toHaveLength(1);
  });

  it("dedupliziert identische Event-Schlüssel", async () => {
    const { eventRepository } = setup();
    const event = {
      name: "customer.created",
      tenantId: "1",
      aggregateType: "customer",
      aggregateId: "1",
      payload: { customerId: "1" },
      idempotencyKey: "customer.created:audit-hash",
    } as const;
    await eventRepository.append({
      ...event,
      id: "00000000-0000-0000-0000-000000000001",
      occurredAt: new Date(),
    });
    await eventRepository.append({
      ...event,
      id: "00000000-0000-0000-0000-000000000002",
      occurredAt: new Date(),
    });
    expect(eventRepository.events).toHaveLength(1);
  });
});
