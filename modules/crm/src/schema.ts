import {
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

export const industries = mysqlTable(
  "industries",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({ nameIdx: index("industries_name_idx").on(table.name) }),
);

export const addresses = mysqlTable(
  "addresses",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id").notNull(),
    company: varchar("company", { length: 255 }),
    contactPerson: varchar("contact_person", { length: 255 }),
    street: varchar("street", { length: 255 }),
    zip: varchar("zip", { length: 32 }),
    city: varchar("city", { length: 255 }),
    country: varchar("country", { length: 64 }).default("DE"),
    phone: varchar("phone", { length: 64 }),
    email: varchar("email", { length: 320 }),
    website: varchar("website", { length: 512 }),
    industryId: int("industry_id"),
    status: mysqlEnum("status", ["pending", "active", "inactive", "duplicate"])
      .default("pending")
      .notNull(),
    metadata: json("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("addresses_tenant_idx").on(table.tenantId),
    cityIdx: index("addresses_city_idx").on(table.city),
  }),
);

export const customers = mysqlTable(
  "customers",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    company: varchar("company", { length: 255 }),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 64 }),
    addressId: int("address_id"),
    industryId: int("industry_id"),
    address: text("address"),
    notes: text("notes"),
    tags: json("tags").$type<string[]>(),
    status: mysqlEnum("status", ["active", "inactive"])
      .default("active")
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("customers_tenant_idx").on(table.tenantId),
    nameIdx: index("customers_name_idx").on(table.name),
  }),
);

export const projects = mysqlTable(
  "projects",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id").notNull(),
    customerId: int("customer_id"),
    addressId: int("address_id"),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    status: mysqlEnum("status", [
      "planning",
      "active",
      "completed",
      "cancelled",
    ])
      .default("planning")
      .notNull(),
    startDate: datetime("start_date"),
    endDate: datetime("end_date"),
    metadata: json("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("projects_tenant_idx").on(table.tenantId),
    customerIdx: index("projects_customer_idx").on(table.customerId),
  }),
);

export const crmSchema = { industries, addresses, customers, projects };
