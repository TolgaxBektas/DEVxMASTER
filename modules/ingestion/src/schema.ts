import { float, int, json, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

export const sources = mysqlTable("ingestion_sources", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenant_id").notNull(),
  url: varchar("url", { length: 700 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  score: float("score").default(0).notNull(),
  metadata: json("metadata"),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  lastFetchedAt: timestamp("last_fetched_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  tenantUrl: uniqueIndex("ingestion_sources_tenant_url_uq").on(table.tenantId, table.url),
}));
export const documents = mysqlTable("ingestion_documents", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenant_id").notNull(),
  sourceId: int("source_id"),
  filename: varchar("filename", { length: 255 }).notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  storageKey: varchar("storage_key", { length: 1024 }).notNull(),
  sizeBytes: int("size_bytes").notNull(),
  mimeType: varchar("mime_type", { length: 128 }).notNull(),
  origin: varchar("origin", { length: 32 }).notNull(),
  state: varchar("state", { length: 32 }).notNull(),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  tenantHash: uniqueIndex("ingestion_documents_tenant_hash").on(table.tenantId, table.sha256),
}));
export const pages = mysqlTable("ingestion_pages", {
  id: int("id").autoincrement().primaryKey(),
  documentId: int("document_id").notNull(),
  pageNumber: int("page_number").notNull(),
  text: text("text"),
  imageKey: varchar("image_key", { length: 1024 }),
  classification: varchar("classification", { length: 64 }),
  adProbability: float("ad_probability"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const occurrences = mysqlTable("ingestion_occurrences", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenant_id").notNull(),
  documentId: int("document_id").notNull(),
  pageId: int("page_id").notNull(),
  company: varchar("company", { length: 255 }).notNull(),
  preview: text("preview").notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  bbox: json("bbox"),
  imageKey: varchar("image_key", { length: 1024 }),
  confidence: float("confidence"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const ingestionSchema = { sources, documents, pages, occurrences };
