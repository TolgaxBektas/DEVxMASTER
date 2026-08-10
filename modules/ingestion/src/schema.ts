import { int, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

export const sources = mysqlTable("ingestion_sources", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenant_id").notNull(),
  url: text("url").notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const documents = mysqlTable("ingestion_documents", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenant_id").notNull(),
  sourceId: int("source_id"),
  filename: varchar("filename", { length: 255 }).notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  state: varchar("state", { length: 32 }).notNull(),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const pages = mysqlTable("ingestion_pages", {
  id: int("id").autoincrement().primaryKey(),
  documentId: int("document_id").notNull(),
  pageNumber: int("page_number").notNull(),
  text: text("text"),
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const ingestionSchema = { sources, documents, pages, occurrences };
