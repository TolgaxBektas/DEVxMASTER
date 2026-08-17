import { eq, and } from "drizzle-orm";
import { createApiApp } from "./app.js";
import {
  createDbFactory,
  createDrizzleAuditRepository,
  createDrizzleEventRepository,
  createLocalProvider,
  createRegistry,
  parseEnv,
  userIdentities,
  users,
  roleAssignments,
  roles,
  hashSecret,
} from "@xmaster-center/kernel";
import { createEventBus } from "@xmaster-center/kernel";
import { LeaseQueue, DrizzleQueueRepository } from "@xmaster-center/jobs";
import { createCrmModule } from "@xmaster-center/module-crm";
import { createSystemModule } from "@xmaster-center/module-system";
import { createBillingModule } from "@xmaster-center/module-billing";
import { createIngestionModule, createPifReviewClient } from "@xmaster-center/module-ingestion";
import { createDrizzleIngestionRepository } from "@xmaster-center/module-ingestion";
import { createAssistantModule } from "@xmaster-center/module-assistant";
import { appendAudit } from "@xmaster-center/kernel";
import { invoices } from "@xmaster-center/module-billing";
import { customers } from "@xmaster-center/module-crm";
import type { ModuleRegistry } from "@xmaster-center/kernel";
import { createConfiguredStorage } from "@xmaster-center/integrations";

const env = parseEnv();
const dbFactory = createDbFactory(env);
const db = dbFactory.get();
const storage = createConfiguredStorage(
  env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY && env.S3_BUCKET
    ? {
        endpoint: env.S3_ENDPOINT,
        accessKey: env.S3_ACCESS_KEY,
        secretKey: env.S3_SECRET_KEY,
        bucket: env.S3_BUCKET,
      }
    : undefined,
);
const audit = createDrizzleAuditRepository(db);
const eventRepository = createDrizzleEventRepository(db);
const queue = new LeaseQueue(new DrizzleQueueRepository(db));
let eventBus: ReturnType<typeof createEventBus>;
let registry: ModuleRegistry;
const system = createSystemModule({
  db,
  audit,
  events: eventRepository,
  queue,
  health: async () => [
    { id: "system", status: "healthy" },
    { id: "crm", status: "healthy" },
    { id: "billing", status: "healthy" },
    { id: "ingestion", status: "healthy" },
    { id: "assistant", status: "healthy" },
  ],
  navigation: (permissions) => registry.navigation({ permissions }),
});
const crm = createCrmModule({
  db,
  audit,
  publish: (input, executor) => eventBus.publish(input, executor),
  enqueue: (input) => queue.enqueue(input),
  getDocumentActuality: async (tenantId, documentId) =>
    (await createDrizzleIngestionRepository(db).getDocument(tenantId, documentId)).actualityStatus,
});
const billing = createBillingModule({
  db,
  audit,
  publish: (input, executor) => eventBus.publish(input, executor),
  transaction: (callback) => db.transaction(callback),
});
const ingestion = createIngestionModule({
  db,
  audit,
  storage,
  maxUploadBytes: env.INGESTION_MAX_UPLOAD_BYTES,
  ...(env.PIF_SERVICE_TOKEN
    ? {
        reviewClient: createPifReviewClient({
          baseUrl: env.PIF_BASE_URL,
          serviceToken: env.PIF_SERVICE_TOKEN,
        }),
      }
    : {}),
  ...(env.PIF_REVIEW_TENANT_ID
    ? { reviewTenantId: env.PIF_REVIEW_TENANT_ID }
    : {}),
  transaction: (callback) => db.transaction(callback),
  repositoryForTransaction: (transactionDb) => createDrizzleIngestionRepository(transactionDb),
  enqueue: (input) => queue.enqueue({
    name: input.name,
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    payload: input.payload,
  }),
  publish: (input) => eventBus.publish(input),
  discoverProposals: async ({ seedPages, searchTerms, maxResults }) => {
    const response = await fetch(`${env.PIF_BASE_URL}/api/v1/discovery/proposals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.PIF_SERVICE_TOKEN ? { "x-service-token": env.PIF_SERVICE_TOKEN } : {}),
      },
      body: JSON.stringify({ seed_pages: seedPages, search_terms: searchTerms, max_results: maxResults }),
    });
    if (!response.ok) throw new Error(`Quellensuche fehlgeschlagen (${response.status})`);
    const body = await response.json() as { proposals?: Array<Record<string, unknown>> };
    return (body.proposals ?? []).map((item) => ({
      url: String(item.url),
      score: Number(item.score ?? 0),
      metadata: item,
    }));
  },
});
const assistant = createAssistantModule({
  briefing: async (tenantId) => {
    const overdue = await db.select().from(invoices);
    const leads = await db.select().from(customers);
    return {
      overdueInvoices: overdue.filter((invoice) => invoice.status === "issued" || invoice.status === "partially_paid").length,
      newLeads: leads.filter((customer) => (customer.tags ?? []).includes("lead")).length,
      deadLetters: 0,
      costsMicros: 0,
      budgetMicros: 1_000_000,
      tenantId,
    };
  },
  chat: async (_tenantId, text) => `ALEXIS Mock: ${text}`,
  audit: async (input) => {
    await appendAudit(audit, {
      tenantId: input.tenantId,
      action: input.action,
      entityType: "assistant",
      entityId: input.entityId,
      actorId: "1",
      actorName: "ALEXIS",
      detailsJson: JSON.stringify(input.details),
    });
  },
});
registry = createRegistry([system, crm, billing, ingestion, assistant]);
eventBus = createEventBus(
  eventRepository,
  [...registry.events.entries()].flatMap(([name, items]) =>
    items
      .filter((item) => item.direction === "subscribed" && item.handle)
      .map((item) => ({
        name,
        handle: item.handle as (event: unknown) => Promise<void>,
      })),
  ),
);

const local = createLocalProvider({
  secret: new TextEncoder().encode(env.JWT_SECRET),
  expiry: env.JWT_EXPIRY,
  findIdentity: async (userId) => {
    const user = (
      await db
        .select()
        .from(users)
        .where(eq(users.id, Number(userId)))
        .limit(1)
    )[0];
    if (!user) return null;
    const assignment = (
      await db
        .select({
          tenantId: roleAssignments.tenantId,
          permissions: roles.permissions,
        })
        .from(roleAssignments)
        .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
        .where(eq(roleAssignments.userId, Number(userId)))
        .limit(1)
    )[0];
    if (!assignment) return null;
    return {
      userId: String(user.id),
      tenantId: String(assignment.tenantId),
      email: user.email,
      displayName: user.displayName,
      rolePermissions: assignment.permissions ?? [],
    };
  },
});

const app = createApiApp({
  registry,
  audit,
  local,
  providers: [local],
  publicOrigin: env.PUBLIC_APP_ORIGIN,
  login: async (input) => {
    const row = (
      await db
        .select({
          user: users,
          identity: userIdentities,
          tenantId: roleAssignments.tenantId,
          permissions: roles.permissions,
        })
        .from(userIdentities)
        .innerJoin(users, eq(users.id, userIdentities.userId))
        .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
        .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
        .where(
          and(
            eq(userIdentities.provider, "local"),
            eq(userIdentities.externalId, input.externalId),
          ),
        )
        .limit(1)
    )[0];
    if (!row || (input.tenantId && input.tenantId !== String(row.tenantId)))
      return null;
    const expected = hashSecret(input.secret, env.JWT_SECRET);
    if (expected !== row.identity.secretHash) return null;
    return {
      userId: String(row.user.id),
      tenantId: String(row.tenantId),
      email: row.user.email,
      displayName: row.user.displayName,
      rolePermissions: row.permissions ?? [],
    };
  },
});

const server = app.listen(env.PORT, () =>
  console.log(`[api] listening on ${env.PORT}`),
);
const shutdown = async () => {
  server.close();
  await dbFactory.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
