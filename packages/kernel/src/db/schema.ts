import {
  boolean,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
export {
  tenants,
  users,
  userIdentities,
  roles,
  roleAssignments,
  settings,
  auditLog,
} from "./schema-core.js";
import {
  tenants,
  users,
  userIdentities,
  roles,
  roleAssignments,
  settings,
  auditLog,
} from "./schema-core.js";

export const eventOutbox = mysqlTable(
  "event_outbox",
  {
    id: int("id").autoincrement().primaryKey(),
    eventId: varchar("event_id", { length: 36 }).notNull(),
    tenantId: int("tenant_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    aggregateType: varchar("aggregate_type", { length: 128 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 128 }).notNull(),
    payload: json("payload").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    publishedAt: datetime("published_at"),
    attempts: int("attempts").default(0).notNull(),
    deliveryAttempts: int("delivery_attempts").default(0).notNull(),
    nextAttemptAt: datetime("next_attempt_at"),
    deadLetter: boolean("dead_letter").default(false).notNull(),
    successfulHandlers: json("successful_handlers").$type<string[]>().notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    eventUnique: uniqueIndex("event_outbox_event_uq").on(table.eventId),
    idempotencyUnique: uniqueIndex("event_outbox_idempotency_uq").on(
      table.idempotencyKey,
    ),
    dispatchIdx: index("event_outbox_dispatch_idx").on(
      table.publishedAt,
      table.createdAt,
    ),
  }),
);

export const jobs = mysqlTable(
  "jobs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: int("tenant_id"),
    name: varchar("name", { length: 128 }).notNull(),
    payload: json("payload").notNull(),
    status: mysqlEnum("status", [
      "pending",
      "processing",
      "completed",
      "failed",
      "dead",
    ])
      .default("pending")
      .notNull(),
    attempts: int("attempts").default(0).notNull(),
    maxAttempts: int("max_attempts").default(5).notNull(),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    leaseToken: varchar("lease_token", { length: 36 }),
    leaseExpiresAt: datetime("lease_expires_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    claimIdx: index("jobs_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    nameIdx: index("jobs_name_idx").on(table.name),
  }),
);

export const jobRuns = mysqlTable("job_runs", {
  id: int("id").autoincrement().primaryKey(),
  jobId: varchar("job_id", { length: 36 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  startedAt: datetime("started_at").notNull(),
  completedAt: datetime("completed_at"),
  errorMessage: text("error_message"),
  metadata: json("metadata"),
});

export const aiUsageLedger = mysqlTable(
  "ai_usage_ledger",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id").notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    operation: varchar("operation", { length: 32 }).notNull(),
    inputTokens: int("input_tokens").default(0).notNull(),
    outputTokens: int("output_tokens").default(0).notNull(),
    costMicros: int("cost_micros").default(0).notNull(),
    objectType: varchar("object_type", { length: 128 }),
    objectId: varchar("object_id", { length: 128 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    tenantCreatedIdx: index("ai_usage_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
  }),
);

export const promptVersions = mysqlTable(
  "prompt_versions",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id"),
    key: varchar("key", { length: 128 }).notNull(),
    version: varchar("version", { length: 64 }).notNull(),
    body: text("body").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["draft", "approved", "retired"])
      .default("draft")
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    promptVersionUnique: uniqueIndex("prompt_versions_key_version_uq").on(
      table.key,
      table.version,
    ),
  }),
);

export const featureFlags = mysqlTable(
  "feature_flags",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id").notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    config: json("config"),
  },
  (table) => ({
    flagUnique: uniqueIndex("feature_flags_tenant_key_uq").on(
      table.tenantId,
      table.key,
    ),
  }),
);

export const automationPolicies = mysqlTable(
  "automation_policies",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id").notNull(),
    operation: varchar("operation", { length: 128 }).notNull(),
    mode: mysqlEnum("mode", ["automatic", "suggestion", "human_required"])
      .default("human_required")
      .notNull(),
    config: json("config"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    policyUnique: uniqueIndex("automation_policies_tenant_operation_uq").on(
      table.tenantId,
      table.operation,
    ),
  }),
);

export const kernelSchema = {
  tenants,
  users,
  userIdentities,
  roles,
  roleAssignments,
  settings,
  auditLog,
  eventOutbox,
  jobs,
  jobRuns,
  aiUsageLedger,
  promptVersions,
  featureFlags,
  automationPolicies,
};

export type KernelSchema = typeof kernelSchema;
