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
import { createIngestionModule } from "@xmaster-center/module-ingestion";
import { createAssistantModule } from "@xmaster-center/module-assistant";
import { appendAudit } from "@xmaster-center/kernel";
import { invoices } from "@xmaster-center/module-billing";
import { customers } from "@xmaster-center/module-crm";
import type { ModuleRegistry } from "@xmaster-center/kernel";

const env = parseEnv();
const dbFactory = createDbFactory(env);
const db = dbFactory.get();
const audit = createDrizzleAuditRepository(db);
const eventRepository = createDrizzleEventRepository(db);
const queue = new LeaseQueue(new DrizzleQueueRepository(db));
let eventBus: ReturnType<typeof createEventBus>;
let registry: ModuleRegistry;
const system = createSystemModule({
  db,
  audit,
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
});
const billing = createBillingModule({
  db,
  audit,
  publish: (input, executor) => eventBus.publish(input, executor),
  transaction: (callback) => db.transaction(callback),
});
const ingestion = createIngestionModule({
  db,
  publish: (input) => eventBus.publish(input),
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
