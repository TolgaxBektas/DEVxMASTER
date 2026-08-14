import {
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  tinyint,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const status = ["active", "inactive", "archived"] as const;

export const tenants = mysqlTable(
  "tenants",
  {
    id: int("id").autoincrement().primaryKey(),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    status: mysqlEnum("status", status).default("active").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({ codeUnique: uniqueIndex("tenants_code_uq").on(table.code) }),
);

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 320 }),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  status: mysqlEnum("status", status).default("active").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export const userIdentities = mysqlTable(
  "user_identities",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    externalId: varchar("external_id", { length: 512 }).notNull(),
    secretHash: varchar("secret_hash", { length: 128 }),
    metadata: json("metadata"),
    expiresAt: datetime("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    providerExternalUnique: uniqueIndex(
      "user_identities_provider_external_uq",
    ).on(table.provider, table.externalId),
    userIdx: index("user_identities_user_idx").on(table.userId),
  }),
);

export const roles = mysqlTable(
  "roles",
  {
    id: int("id").autoincrement().primaryKey(),
    code: varchar("code", { length: 128 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    permissions: json("permissions").$type<string[]>().notNull(),
  },
  (table) => ({ codeUnique: uniqueIndex("roles_code_uq").on(table.code) }),
);

export const roleAssignments = mysqlTable(
  "role_assignments",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").notNull(),
    tenantId: int("tenant_id").notNull(),
    roleId: int("role_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    assignmentUnique: uniqueIndex("role_assignments_user_tenant_role_uq").on(
      table.userId,
      table.tenantId,
      table.roleId,
    ),
    tenantUserIdx: index("role_assignments_tenant_user_idx").on(
      table.tenantId,
      table.userId,
    ),
  }),
);

export const settings = mysqlTable(
  "settings",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id").notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    value: text("value"),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    tenantKeyUnique: uniqueIndex("settings_tenant_key_uq").on(
      table.tenantId,
      table.key,
    ),
  }),
);

export const auditLog = mysqlTable(
  "audit_log",
  {
    id: int("id").autoincrement().primaryKey(),
    seq: int("seq").notNull(),
    tenantId: int("tenant_id"),
    action: varchar("action", { length: 128 }).notNull(),
    entityType: varchar("entity_type", { length: 128 }).notNull(),
    entityId: varchar("entity_id", { length: 128 }),
    detailsJson: text("details_json"),
    actorId: int("actor_id"),
    actorName: varchar("actor_name", { length: 255 }),
    prevHash: varchar("prev_hash", { length: 64 }).notNull(),
    hash: varchar("hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).defaultNow().notNull(),
  },
  (table) => ({
    seqUnique: uniqueIndex("audit_log_seq_uq").on(table.seq),
    hashIdx: index("audit_log_hash_idx").on(table.hash),
  }),
);

export const auditChainHeads = mysqlTable("audit_chain_heads", {
  id: tinyint("id").primaryKey(),
  seq: int("seq").notNull(),
  hash: varchar("hash", { length: 64 }).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export const coreSchema = {
  tenants,
  users,
  userIdentities,
  roles,
  roleAssignments,
  settings,
  auditLog,
  auditChainHeads,
};
