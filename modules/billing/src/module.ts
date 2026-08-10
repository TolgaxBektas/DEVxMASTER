import {
  createDrizzleAuditRepository,
  createDrizzleEventRepository,
  defineModule,
  type EventExecutor,
  type ModuleDefinition,
} from "@xmaster-center/kernel";
import { PdfKitPdf } from "@xmaster-center/integrations";
import { createBillingRouter } from "./router.js";
import { createDrizzleBillingRepository } from "./drizzle-repository.js";
import { createBillingService } from "./service.js";
import { billingPages, BillingPage } from "./ui/index.js";
import { billingSchema } from "./schema.js";

export { billingPages } from "./ui/index.js";

export function createBillingModule(deps: {
  db: unknown;
  audit: ReturnType<typeof createDrizzleAuditRepository>;
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
  transaction<T>(callback: (db: unknown) => Promise<T>): Promise<T>;
}): ModuleDefinition {
  const service = createBillingService({
    repository: createDrizzleBillingRepository(deps.db),
    repositoryFor: createDrizzleBillingRepository,
    audit: deps.audit,
    auditFor: (db) => createDrizzleAuditRepository(db),
    transaction: deps.transaction,
    eventExecutorFor: (db) => createDrizzleEventRepository(db),
    publish: deps.publish,
    pdf: new PdfKitPdf(),
  });
  return defineModule({
    id: "billing",
    title: "Faktura",
    icon: "receipt",
    version: "0.1.0",
    schema: billingSchema,
    router: createBillingRouter(service),
    nav: [
      {
        id: "billing.overview",
        label: "Faktura",
        href: "/billing",
        permission: "billing.invoice.read",
        order: 10,
      },
      {
        id: "billing.issuers",
        label: "Aussteller",
        href: "/billing/issuers",
        permission: "billing.issuer.read",
        order: 20,
      },
      {
        id: "billing.invoices",
        label: "Rechnungen",
        href: "/billing/invoices",
        permission: "billing.invoice.read",
        order: 30,
      },
      {
        id: "billing.dunning",
        label: "Mahnwesen",
        href: "/billing/dunning",
        permission: "billing.dunning.read",
        order: 40,
      },
    ],
    pages: billingPages.map(([id, title, path, permission]) => ({
      id,
      title,
      path,
      permission,
      component: BillingPage,
    })),
    permissions: [
      { permission: "billing.issuer.read", title: "Aussteller lesen" },
      { permission: "billing.issuer.write", title: "Aussteller ändern" },
      { permission: "billing.invoice.read", title: "Rechnungen lesen" },
      { permission: "billing.invoice.write", title: "Rechnungen anlegen" },
      { permission: "billing.invoice.issue", title: "Rechnungen ausstellen" },
      { permission: "billing.payment.write", title: "Zahlungen erfassen" },
      { permission: "billing.dunning.read", title: "Mahnungen lesen" },
      { permission: "billing.dunning.run", title: "Mahnlauf ausführen" },
      { permission: "billing.creditnote.write", title: "Gutschriften anlegen" },
    ],
    jobs: [
      {
        name: "billing.dunning.run",
        schedule: "daily",
        handle: async (payload) => {
          const value = payload as { tenantId?: string };
          if (value.tenantId) {
            await service.runDunning(value.tenantId, {
              actorId: null,
              actorName: "Scheduler",
            });
          }
        },
      },
    ],
    events: [
      { name: "invoice.created", direction: "published" },
      { name: "invoice.issued", direction: "published" },
      { name: "invoice.paid", direction: "published" },
      { name: "invoice.overdue", direction: "published" },
      { name: "dunning.issued", direction: "published" },
      { name: "creditnote.created", direction: "published" },
    ],
    health: () => ({ id: "billing", status: "healthy" }),
  });
}
