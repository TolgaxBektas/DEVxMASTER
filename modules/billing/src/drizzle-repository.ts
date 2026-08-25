import type { MySql2Database } from "drizzle-orm/mysql2";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  billingSchema,
  creditNotes,
  dunningLevels,
  dunningLog,
  invoiceItems,
  invoices,
  issuers,
  payments,
  quoteItems,
  quotes,
} from "./schema.js";
import { quoteNumber } from "./formulas.js";
import type {
  BillingRepository,
  CreateInvoiceInput,
  CreateQuoteInput,
} from "./repository.js";

type BillingDb = MySql2Database<typeof billingSchema>;

export function createDrizzleBillingRepository(db: unknown): BillingRepository {
  const database = db as BillingDb;
  return {
    async listIssuers(tenantId) {
      return database
        .select()
        .from(issuers)
        .where(eq(issuers.tenantId, Number(tenantId))) as never;
    },
    async createIssuer(tenantId, input) {
      const result = await database
        .insert(issuers)
        .values({
          ...input,
          tenantId: Number(tenantId),
          paymentTermDays: input.paymentTermDays ?? 14,
        });
      const row = await database
        .select()
        .from(issuers)
        .where(eq(issuers.id, Number(result[0]?.insertId)))
        .limit(1);
      return row[0] as never;
    },
    async listQuotes(tenantId) {
      return database
        .select()
        .from(quotes)
        .where(eq(quotes.tenantId, Number(tenantId)))
        .orderBy(desc(quotes.createdAt)) as never;
    },
    async getQuote(tenantId, id) {
      const rows = await database
        .select()
        .from(quotes)
        .where(and(eq(quotes.id, id), eq(quotes.tenantId, Number(tenantId))))
        .limit(1);
      return (rows[0] ?? null) as never;
    },
    async getQuoteForUpdate(tenantId, id) {
      const rows = await database
        .select()
        .from(quotes)
        .where(and(eq(quotes.id, id), eq(quotes.tenantId, Number(tenantId))))
        .limit(1)
        .for("update");
      return (rows[0] ?? null) as never;
    },
    async getQuoteItems(_tenantId, id) {
      return database
        .select()
        .from(quoteItems)
        .where(eq(quoteItems.quoteId, id))
        .orderBy(quoteItems.position) as never;
    },
    async createQuote(tenantId, input: CreateQuoteInput) {
      const issuer = (
        await database
          .select()
          .from(issuers)
          .where(and(
            eq(issuers.id, input.issuerId),
            eq(issuers.tenantId, Number(tenantId)),
          ))
          .limit(1)
          .for("update")
      )[0];
      if (!issuer) throw new Error("Aussteller nicht gefunden");
      const year = new Date().getFullYear();
      const sequence = issuer.quoteNumberYear === year
        ? issuer.nextQuoteNumber
        : 1;
      await database
        .update(issuers)
        .set({ nextQuoteNumber: sequence + 1, quoteNumberYear: year })
        .where(eq(issuers.id, issuer.id));
      const result = await database.insert(quotes).values({
        tenantId: Number(tenantId),
        issuerId: issuer.id,
        customerId: input.customerId,
        occurrenceId: input.occurrenceId,
        adImageKey: input.adImageKey,
        quoteNumber: quoteNumber(
          issuer.quotePrefix ?? `AG-${issuer.invoicePrefix}`,
          year,
          sequence,
        ),
        status: "draft",
        currency: input.currency,
        vatTreatment: input.vatTreatment,
        subtotal: input.subtotal,
        vatRate: input.vatRate,
        vatAmount: input.vatAmount,
        total: input.total,
        validUntil: input.validUntil,
        recipientName: input.recipientName,
        recipientAddress: input.recipientAddress,
        recipientEmail: input.recipientEmail,
        notes: input.notes,
        metadata: input.metadata,
      });
      const id = Number(result[0]?.insertId);
      await database.insert(quoteItems).values(input.items.map((item, index) => ({
        quoteId: id,
        position: index + 1,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
        commissionRate: item.commissionRate,
        customerId: item.customerId,
      })));
      return (await this.getQuote(tenantId, id)) as never;
    },
    async setQuoteStatus(tenantId, id, status) {
      const quote = await this.getQuote(tenantId, id);
      if (!quote) throw new Error("Angebot nicht gefunden");
      await database.update(quotes).set({ status }).where(eq(quotes.id, id));
      return (await this.getQuote(tenantId, id)) as never;
    },
    async setQuoteInvoiceId(tenantId, id, invoiceId) {
      const quote = await this.getQuote(tenantId, id);
      if (!quote) throw new Error("Angebot nicht gefunden");
      if (quote.invoiceId == null) {
        await database.update(quotes).set({ invoiceId }).where(and(
          eq(quotes.id, id),
          eq(quotes.tenantId, Number(tenantId)),
          sql`${quotes.invoiceId} IS NULL`,
        ));
      }
      return (await this.getQuote(tenantId, id)) as never;
    },
    async listInvoices(tenantId) {
      return database
        .select()
        .from(invoices)
        .where(eq(invoices.tenantId, Number(tenantId)))
        .orderBy(desc(invoices.createdAt)) as never;
    },
    async getInvoice(tenantId, id) {
      const rows = await database
        .select()
        .from(invoices)
        .where(
          and(eq(invoices.id, id), eq(invoices.tenantId, Number(tenantId))),
        )
        .limit(1);
      return (rows[0] ?? null) as never;
    },
    async getInvoiceItems(_tenantId, id) {
      return database
        .select()
        .from(invoiceItems)
        .where(eq(invoiceItems.invoiceId, id))
        .orderBy(invoiceItems.position) as never;
    },
    async createInvoice(tenantId, input: CreateInvoiceInput) {
      const issuer = (
        await database
          .select()
          .from(issuers)
          .where(
            and(
              eq(issuers.id, input.issuerId),
              eq(issuers.tenantId, Number(tenantId)),
            ),
          )
          .limit(1)
      )[0];
      if (!issuer) throw new Error("Aussteller nicht gefunden");
      const year = new Date().getFullYear();
      const sequence = issuer.numberYear === year ? issuer.nextNumber : 1;
      await database
        .update(issuers)
        .set({ nextNumber: sequence + 1, numberYear: year })
        .where(eq(issuers.id, issuer.id));
      if (sequence > 9999) throw new Error("Nummernkreis erschöpft");
      const invoiceNumber = `${issuer.invoicePrefix}-${year}-${String(sequence).padStart(4, "0")}`;
      const result = await database.insert(invoices).values({
        tenantId: Number(tenantId),
        issuerId: issuer.id,
        customerId: input.customerId,
        invoiceNumber,
        currency: input.currency,
        vatTreatment: input.vatTreatment,
        subtotal: input.subtotal,
        vatRate: input.vatRate,
        vatAmount: input.vatAmount,
        total: input.total,
        dueDate: input.dueDate,
        recipientName: input.recipientName,
        recipientAddress: input.recipientAddress,
        recipientEmail: input.recipientEmail,
      });
      const id = Number(result[0]?.insertId);
      await database.insert(invoiceItems).values(
        input.items.map((item, index) => ({
          invoiceId: id,
          position: index + 1,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          amount: item.amount,
          commissionRate: item.commissionRate,
          customerId: item.customerId,
        })),
      );
      return (await this.getInvoice(tenantId, id)) as never;
    },
    async setInvoiceIssued(tenantId, id, issueDate, dueDate) {
      const invoice = await this.getInvoice(tenantId, id);
      if (!invoice) throw new Error("Rechnung nicht gefunden");
      if (invoice.status !== "draft")
        throw new Error("Nur Entwürfe können ausgestellt werden");
      await database
        .update(invoices)
        .set({ status: "issued", issueDate, dueDate })
        .where(eq(invoices.id, id));
      return (await this.getInvoice(tenantId, id)) as never;
    },
    async addPayment(tenantId, id, payment) {
      const invoice = await this.getInvoice(tenantId, id);
      if (!invoice || !["issued", "partially_paid"].includes(invoice.status))
        throw new Error("Rechnung ist nicht zahlbar");
      const result = await database
        .insert(payments)
        .values({ invoiceId: id, ...payment });
      const paid = await database
        .select({ total: sql<string>`COALESCE(SUM(${payments.amount}), 0)` })
        .from(payments)
        .where(eq(payments.invoiceId, id));
      const paidAmount = String(paid[0]?.total ?? "0.00");
      await database
        .update(invoices)
        .set({
          paidAmount,
          status: paidAmount === invoice.total ? "paid" : "partially_paid",
        })
        .where(eq(invoices.id, id));
      const rows = await database
        .select()
        .from(payments)
        .where(eq(payments.id, Number(result[0]?.insertId)))
        .limit(1);
      return rows[0] as never;
    },
    async listPayments(tenantId, id) {
      const invoice = await this.getInvoice(tenantId, id);
      return invoice
        ? (database
            .select()
            .from(payments)
            .where(eq(payments.invoiceId, id))
            .orderBy(desc(payments.paidAt)) as never)
        : [];
    },
    async listDunningLevels(tenantId) {
      return database
        .select()
        .from(dunningLevels)
        .where(
          and(
            eq(dunningLevels.tenantId, Number(tenantId)),
            eq(dunningLevels.active, 1),
          ),
        )
        .orderBy(dunningLevels.level) as never;
    },
    async listDunningEntries(tenantId) {
      return database
        .select()
        .from(dunningLog)
        .where(eq(dunningLog.tenantId, Number(tenantId)))
        .orderBy(desc(dunningLog.createdAt)) as never;
    },
    async createDunningEntry(tenantId, entry) {
      const result = await database.insert(dunningLog).values({
        tenantId: Number(tenantId),
        invoiceId: entry.invoiceId,
        level: entry.level,
        feeAmount: entry.feeAmount,
        interestAmount: entry.interestAmount,
        totalDue: entry.totalDue,
        subject: entry.subject,
        body: entry.body,
      });
      const rows = await database
        .select()
        .from(dunningLog)
        .where(eq(dunningLog.id, Number(result[0]?.insertId)))
        .limit(1);
      return rows[0] as never;
    },
    async nextCreditNumber(tenantId, issuerId) {
      const issuer = (
        await database
          .select()
          .from(issuers)
          .where(
            and(
              eq(issuers.id, issuerId),
              eq(issuers.tenantId, Number(tenantId)),
            ),
          )
          .limit(1)
      )[0];
      if (!issuer) throw new Error("Aussteller nicht gefunden");
      const sequence = issuer.nextNumber;
      await database
        .update(issuers)
        .set({ nextNumber: sql`${issuers.nextNumber} + 1` })
        .where(eq(issuers.id, issuerId));
      return `GS-${issuer.invoicePrefix}-${new Date().getFullYear()}-${String(sequence).padStart(4, "0")}`;
    },
    async createCreditNote(input) {
      await database
        .insert(creditNotes)
        .values({ ...input, tenantId: Number(input.tenantId) });
    },
  };
}
