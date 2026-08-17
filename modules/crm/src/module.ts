import {
  createDrizzleAuditRepository,
  createDrizzleEventRepository,
  defineModule,
  appendAudit,
  type EventExecutor,
  type ModuleDefinition,
} from "@xmaster-center/kernel";
import { createCrmRouter } from "./router.js";
import { crmSchema } from "./schema.js";
import { createDrizzleCrmRepository } from "./repository.js";
import { crmPages, CrmPage } from "./ui/index.js";

export { crmPages } from "./ui/index.js";

export function createCrmModule(deps: {
  db: any;
  audit: any;
  publish(
    input: {
      name: string;
      tenantId: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
      idempotencyKey: string;
    },
    executor?: EventExecutor,
  ): Promise<unknown>;
  enqueue(input: {
    name: string;
    tenantId: string;
    payload: unknown;
  }): Promise<unknown>;
}): ModuleDefinition {
  const repository = createDrizzleCrmRepository(deps.db);
  return defineModule({
    id: "crm",
    title: "CRM",
    icon: "users",
    version: "0.1.0",
    schema: crmSchema,
    router: createCrmRouter({
      ...deps,
      repository,
      repositoryFor: (db) => createDrizzleCrmRepository(db),
      auditFor: (db) => createDrizzleAuditRepository(db),
      transaction: (callback) => deps.db.transaction(callback),
      eventExecutorFor: (db) => createDrizzleEventRepository(db),
    }),
    nav: [
      {
        id: "crm.customers",
        label: "Kunden",
        href: "/kunden",
        permission: "crm.customer.read",
        order: 10,
      },
      {
        id: "crm.addresses",
        label: "Adressen",
        href: "/adressen",
        permission: "crm.address.read",
        order: 20,
      },
      {
        id: "crm.industries",
        label: "Branchen",
        href: "/branchen",
        permission: "crm.industry.read",
        order: 30,
      },
      {
        id: "crm.projects",
        label: "Projekte",
        href: "/projekte",
        permission: "crm.project.read",
        order: 40,
      },
    ],
    pages: crmPages.map(([id, title, path, permission]) => ({
      id,
      title,
      path,
      permission,
      component: CrmPage,
    })),
    permissions: [
      { permission: "crm.customer.read", title: "Kunden lesen" },
      { permission: "crm.customer.write", title: "Kunden ändern" },
      { permission: "crm.address.read", title: "Adressen lesen" },
      { permission: "crm.address.write", title: "Adressen ändern" },
      { permission: "crm.industry.read", title: "Branchen lesen" },
      { permission: "crm.project.read", title: "Projekte lesen" },
    ],
    jobs: [
      {
        name: "crm.customer.enrich",
        async handle(payload) {
          console.log("[jobs] CRM-Anreicherung abgeschlossen", payload);
        },
        maxAttempts: 3,
      },
    ],
    events: [
      { name: "customer.created", direction: "published" },
      { name: "customer.updated", direction: "published" },
      { name: "customer.deleted", direction: "published" },
      { name: "address.created", direction: "published" },
      {
        name: "customer.created",
        direction: "subscribed",
        handle: (event) => {
          const payload = event as {
            tenantId: string;
            payload: { customerId: string };
          };
          return deps
            .enqueue({
              name: "crm.customer.enrich",
              tenantId: payload.tenantId,
              payload: payload.payload,
            })
            .then(() => undefined);
        },
      },
      {
        name: "advertisement.detected",
        direction: "subscribed",
        handle: async (event) => {
          const input = event as {
            tenantId: string;
            payload: {
              occurrenceId: number;
              documentId: number;
              company: string;
              preview: string;
              actualityStatus?: "current" | "outdated" | "unverified";
            };
          };
          if (input.payload.actualityStatus !== "current") return;
          try {
            await deps.db.transaction(async (db: unknown) => {
            const repository = createDrizzleCrmRepository(db);
            const audit = createDrizzleAuditRepository(db);
            const customer = await repository.createCustomer(input.tenantId, {
              name: input.payload.company,
              company: input.payload.company,
              notes: `Quelle Dokument ${input.payload.documentId}, Fundstelle ${input.payload.occurrenceId}: ${input.payload.preview}`,
              tags: ["lead", "ingestion"],
            });
            await appendAudit(audit, {
              tenantId: input.tenantId,
              action: "lead.created",
              entityType: "customer",
              entityId: String((customer as { id?: number } | null)?.id ?? ""),
              actorId: "1",
              actorName: "Ingestion-Verarbeitung",
              detailsJson: JSON.stringify(input.payload),
            });
            });
          } catch (error) {
            console.error("[crm] advertisement lead failed", error);
            throw error;
          }
        },
      },
    ],
    health: () => ({ id: "crm", status: "healthy" }),
  });
}
