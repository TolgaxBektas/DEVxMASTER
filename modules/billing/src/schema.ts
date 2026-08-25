import {
  decimal,
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

const currency = ["EUR", "GBP"] as const;
const vatTreatment = ["RC", "VAT19", "VAT0"] as const;

export const issuers = mysqlTable(
  "billing_issuers",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    address: text("address"),
    email: varchar("email", { length: 320 }),
    taxId: varchar("tax_id", { length: 64 }),
    invoicePrefix: varchar("invoice_prefix", { length: 20 }).notNull(),
    nextNumber: int("next_number").default(1).notNull(),
    numberYear: int("number_year"),
    quotePrefix: varchar("quote_prefix", { length: 20 }),
    nextQuoteNumber: int("next_quote_number").default(1).notNull(),
    quoteNumberYear: int("quote_number_year"),
    paymentTermDays: int("payment_term_days").default(14).notNull(),
    bankName: varchar("bank_name", { length: 255 }),
    iban: varchar("iban", { length: 50 }),
    bic: varchar("bic", { length: 20 }),
    logoUrl: text("logo_url"),
    letterhead: text("letterhead"),
    currency: mysqlEnum("currency", currency).default("EUR").notNull(),
    vatTreatment: mysqlEnum("vat_treatment", vatTreatment)
      .default("RC")
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("billing_issuers_tenant_idx").on(table.tenantId),
    prefixUnique: uniqueIndex("billing_issuers_prefix_uq").on(
      table.tenantId,
      table.invoicePrefix,
    ),
  }),
);

export const invoices = mysqlTable(
  "billing_invoices",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id").notNull(),
    issuerId: int("issuer_id").notNull(),
    customerId: int("customer_id"),
    invoiceNumber: varchar("invoice_number", { length: 64 }).notNull(),
    status: mysqlEnum("status", [
      "draft",
      "issued",
      "partially_paid",
      "paid",
      "cancelled",
    ])
      .default("draft")
      .notNull(),
    currency: mysqlEnum("currency", currency).notNull(),
    vatTreatment: mysqlEnum("vat_treatment", vatTreatment).notNull(),
    subtotal: decimal("subtotal", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    vatRate: decimal("vat_rate", { precision: 5, scale: 2 })
      .default("0.00")
      .notNull(),
    vatAmount: decimal("vat_amount", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    total: decimal("total", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    paidAmount: decimal("paid_amount", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    issueDate: timestamp("issue_date"),
    dueDate: timestamp("due_date"),
    recipientName: varchar("recipient_name", { length: 255 }).notNull(),
    recipientAddress: text("recipient_address"),
    recipientEmail: varchar("recipient_email", { length: 320 }),
    notes: text("notes"),
    metadata: json("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("billing_invoices_tenant_idx").on(table.tenantId),
    numberUnique: uniqueIndex("billing_invoice_number_uq").on(
      table.tenantId,
      table.invoiceNumber,
    ),
  }),
);

export const invoiceItems = mysqlTable(
  "billing_invoice_items",
  {
    id: int("id").autoincrement().primaryKey(),
    invoiceId: int("invoice_id").notNull(),
    position: int("position").notNull(),
    description: varchar("description", { length: 500 }).notNull(),
    quantity: decimal("quantity", { precision: 12, scale: 2 }).notNull(),
    unitPrice: decimal("unit_price", { precision: 14, scale: 2 }).notNull(),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    commissionRate: decimal("commission_rate", { precision: 5, scale: 2 }),
    customerId: int("customer_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    invoiceIdx: index("billing_items_invoice_idx").on(table.invoiceId),
  }),
);

export const quotes = mysqlTable(
  "billing_quotes",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id").notNull(),
    issuerId: int("issuer_id").notNull(),
    customerId: int("customer_id"),
    occurrenceId: int("occurrence_id"),
    adImageKey: varchar("ad_image_key", { length: 1024 }),
    quoteNumber: varchar("quote_number", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["draft", "sent", "accepted", "declined"])
      .default("draft")
      .notNull(),
    currency: mysqlEnum("currency", currency).notNull(),
    vatTreatment: mysqlEnum("vat_treatment", vatTreatment).notNull(),
    subtotal: decimal("subtotal", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    vatRate: decimal("vat_rate", { precision: 5, scale: 2 })
      .default("0.00")
      .notNull(),
    vatAmount: decimal("vat_amount", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    total: decimal("total", { precision: 14, scale: 2 })
      .default("0.00")
      .notNull(),
    validUntil: timestamp("valid_until"),
    recipientName: varchar("recipient_name", { length: 255 }).notNull(),
    recipientAddress: text("recipient_address"),
    recipientEmail: varchar("recipient_email", { length: 320 }),
    invoiceId: int("invoice_id"),
    notes: text("notes"),
    metadata: json("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("billing_quotes_tenant_idx").on(table.tenantId),
    numberUnique: uniqueIndex("billing_quote_number_uq").on(
      table.tenantId,
      table.quoteNumber,
    ),
  }),
);

export const quoteItems = mysqlTable(
  "billing_quote_items",
  {
    id: int("id").autoincrement().primaryKey(),
    quoteId: int("quote_id").notNull(),
    position: int("position").notNull(),
    description: varchar("description", { length: 500 }).notNull(),
    quantity: decimal("quantity", { precision: 12, scale: 2 }).notNull(),
    unitPrice: decimal("unit_price", { precision: 14, scale: 2 }).notNull(),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    commissionRate: decimal("commission_rate", { precision: 5, scale: 2 }),
    customerId: int("customer_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    quoteIdx: index("billing_items_quote_idx").on(table.quoteId),
  }),
);

export const payments = mysqlTable(
  "billing_payments",
  {
    id: int("id").autoincrement().primaryKey(),
    invoiceId: int("invoice_id").notNull(),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    paidAt: timestamp("paid_at").notNull(),
    reference: varchar("reference", { length: 255 }),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    invoiceIdx: index("billing_payments_invoice_idx").on(table.invoiceId),
  }),
);

export const dunningLevels = mysqlTable(
  "billing_dunning_levels",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id").notNull(),
    level: int("level").notNull(),
    daysAfterDue: int("days_after_due").notNull(),
    feeAmount: decimal("fee_amount", { precision: 14, scale: 2 }).notNull(),
    interestRate: decimal("interest_rate", {
      precision: 7,
      scale: 4,
    }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
    bodyTemplate: text("body_template").notNull(),
    active: int("active").default(1).notNull(),
  },
  (table) => ({
    levelUnique: uniqueIndex("billing_dunning_level_uq").on(
      table.tenantId,
      table.level,
    ),
  }),
);

export const dunningLog = mysqlTable(
  "billing_dunning_log",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id").notNull(),
    invoiceId: int("invoice_id").notNull(),
    level: int("level").notNull(),
    feeAmount: decimal("fee_amount", { precision: 14, scale: 2 }).notNull(),
    interestAmount: decimal("interest_amount", {
      precision: 14,
      scale: 2,
    }).notNull(),
    totalDue: decimal("total_due", { precision: 14, scale: 2 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    invoiceIdx: index("billing_dunning_invoice_idx").on(table.invoiceId),
    invoiceLevelUnique: uniqueIndex("billing_dunning_invoice_level_uq").on(
      table.tenantId,
      table.invoiceId,
      table.level,
    ),
  }),
);

export const creditNotes = mysqlTable(
  "billing_credit_notes",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenant_id").notNull(),
    issuerId: int("issuer_id").notNull(),
    invoiceId: int("invoice_id"),
    creditNumber: varchar("credit_number", { length: 64 }).notNull(),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    currency: mysqlEnum("currency", currency).notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    numberUnique: uniqueIndex("billing_credit_number_uq").on(
      table.tenantId,
      table.creditNumber,
    ),
  }),
);

export const billingSchema = {
  issuers,
  invoices,
  invoiceItems,
  quotes,
  quoteItems,
  payments,
  dunningLevels,
  dunningLog,
  creditNotes,
};
