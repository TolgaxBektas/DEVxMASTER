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
  health: async () => [{ id: "system", status: "healthy" }],
  navigation: (permissions) => registry.navigation({ permissions }),
});
const crm = createCrmModule({
  db,
  audit,
  publish: (input, executor) => eventBus.publish(input, executor),
  enqueue: (input) => queue.enqueue(input),
});
registry = createRegistry([system, crm]);
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
