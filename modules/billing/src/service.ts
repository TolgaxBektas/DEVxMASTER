import {
  appendAudit,
  type AuditRepository,
  type EventExecutor,
} from "@xmaster-center/kernel";
import type { Pdf } from "@xmaster-center/integrations";
import { dunningCharges, dueDate, positionAmount, totals } from "./formulas.js";
import { addMoney } from "./money.js";
import type {
  BillingRepository,
  CreateInvoiceInput,
  CreateIssuerInput,
  CreateQuoteInput,
} from "./repository.js";
import type { Invoice, Quote } from "./types.js";

export class BillingDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingDomainError";
  }
}

export type BillingServiceDeps = {
  repository: BillingRepository;
  repositoryFor(db: unknown): BillingRepository;
  audit: AuditRepository;
  auditFor(db: unknown): AuditRepository;
  transaction<T>(callback: (db: unknown) => Promise<T>): Promise<T>;
  eventExecutorFor(db: unknown): EventExecutor;
  publish(
    input: {
      name: string;
      tenantId: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
      idempotencyKey: string;
    },
    executor?: EventExecutor,
  ): Promise<unknown>;
  pdf: Pdf;
  resolveAdSource?: (
    tenantId: string,
    occurrenceId: number,
  ) => Promise<{ imageKey: string | null; company: string } | null>;
};

async function createInvoiceInTransaction(
  deps: BillingServiceDeps,
  db: unknown,
  tenantId: string,
  input: CreateInvoiceInput,
  actor: Actor,
): Promise<Invoice> {
  const repository = deps.repositoryFor(db);
  const issuer = (await repository.listIssuers(tenantId)).find(
    (item) => item.id === input.issuerId,
  );
  if (!issuer) throw new BillingDomainError("Aussteller nicht gefunden");
  const items = input.items.map((item) => ({
    ...item,
    amount: positionAmount(item.quantity, item.unitPrice),
  }));
  const subtotal = items.reduce(
    (sum, item) => addMoney(sum, item.amount),
    "0.00",
  );
  const invoiceTotals = totals(subtotal, issuer.vatTreatment);
  const invoice = await repository.createInvoice(tenantId, {
    ...input,
    items,
    subtotal,
    currency: issuer.currency,
    vatTreatment: issuer.vatTreatment,
    vatRate: invoiceTotals.rate,
    vatAmount: invoiceTotals.amount,
    total: invoiceTotals.total,
  });
  const entry = await appendAudit(deps.auditFor(db), {
    tenantId,
    action: "invoice.created",
    entityType: "invoice",
    entityId: invoice.id,
    actorId: actor.actorId,
    actorName: actor.actorName,
    detailsJson: JSON.stringify({ invoiceNumber: invoice.invoiceNumber }),
  });
  await deps.publish({
    name: "invoice.created",
    tenantId,
    aggregateType: "invoice",
    aggregateId: String(invoice.id),
    payload: { invoiceId: invoice.id },
    idempotencyKey: `invoice.created:${entry.hash}`,
  }, deps.eventExecutorFor(db));
  return invoice;
}

async function transitionQuote(
  deps: BillingServiceDeps,
  tenantId: string,
  id: number,
  from: Quote["status"],
  to: Quote["status"],
  actor: Actor,
) {
  return deps.transaction(async (db) => {
    const repository = deps.repositoryFor(db);
    const quote = await repository.getQuote(tenantId, id);
    if (!quote) throw new BillingDomainError("Angebot nicht gefunden");
    if (quote.status !== from) {
      throw new BillingDomainError(
        from === "draft"
          ? "Nur Entwürfe können versendet werden"
          : "Nur versendete Angebote können abgelehnt werden",
      );
    }
    const updated = await repository.setQuoteStatus(tenantId, id, to);
    const action = to === "sent" ? "quote.sent" : "quote.declined";
    const entry = await appendAudit(deps.auditFor(db), {
      tenantId,
      action,
      entityType: "quote",
      entityId: id,
      actorId: actor.actorId,
      actorName: actor.actorName,
      detailsJson: JSON.stringify({ quoteNumber: updated.quoteNumber }),
    });
    await deps.publish({
      name: action,
      tenantId,
      aggregateType: "quote",
      aggregateId: String(id),
      payload: { quoteId: id },
      idempotencyKey: `${action}:${entry.hash}`,
    }, deps.eventExecutorFor(db));
    return updated;
  });
}

export function createBillingService(deps: BillingServiceDeps) {
  return {
    listIssuers: (tenantId: string) => deps.repository.listIssuers(tenantId),
    listInvoices: (tenantId: string) => deps.repository.listInvoices(tenantId),
    listQuotes: (tenantId: string) => deps.repository.listQuotes(tenantId),
    listDunningEntries: (tenantId: string) =>
      deps.repository.listDunningEntries(tenantId),
    getInvoice: (tenantId: string, id: number) =>
      deps.repository.getInvoice(tenantId, id),
    getQuote: (tenantId: string, id: number) =>
      deps.repository.getQuote(tenantId, id),
    async createIssuer(
      tenantId: string,
      input: CreateIssuerInput,
      actor: Actor,
    ) {
      return deps.transaction(async (db) => {
        const repository = deps.repositoryFor(db);
        const audit = deps.auditFor(db);
        const issuer = await repository.createIssuer(tenantId, input);
        await appendAudit(audit, {
          tenantId,
          action: "issuer.created",
          entityType: "issuer",
          entityId: issuer.id,
          actorId: actor.actorId,
          actorName: actor.actorName,
          detailsJson: JSON.stringify(input),
        });
        return issuer;
      });
    },
    async createInvoice(
      tenantId: string,
      input: CreateInvoiceInput,
      actor: Actor,
    ) {
      return deps.transaction(async (db) => {
        return createInvoiceInTransaction(deps, db, tenantId, input, actor);
      });
    },
    async createQuote(
      tenantId: string,
      input: {
        issuerId: number;
        customerId?: number | undefined;
        occurrenceId?: number | undefined;
        recipientName: string;
        recipientAddress?: string | undefined;
        recipientEmail?: string | undefined;
        validUntil?: Date | undefined;
        notes?: string | undefined;
        metadata?: Record<string, unknown> | undefined;
        items: Array<{
          description: string;
          quantity: string;
          unitPrice: string;
          commissionRate?: string | undefined;
          customerId?: number | undefined;
        }>;
      },
      actor: Actor,
    ) {
      return deps.transaction(async (db) => {
        const repository = deps.repositoryFor(db);
        const issuer = (await repository.listIssuers(tenantId)).find(
          (item) => item.id === input.issuerId,
        );
        if (!issuer) throw new BillingDomainError("Aussteller nicht gefunden");
        let adImageKey: string | null = null;
        let metadata = input.metadata;
        if (input.occurrenceId !== undefined) {
          const source = await deps.resolveAdSource?.(tenantId, input.occurrenceId);
          if (!source) throw new BillingDomainError("Fundstelle nicht gefunden");
          adImageKey = source.imageKey;
          metadata = {
            ...(input.metadata ?? {}),
            occurrenceCompany: source.company,
          };
        }
        const items = input.items.map((item) => ({
          ...item,
          amount: positionAmount(item.quantity, item.unitPrice),
        }));
        const subtotal = items.reduce(
          (sum, item) => addMoney(sum, item.amount),
          "0.00",
        );
        const quoteTotals = totals(subtotal, issuer.vatTreatment);
        const quote = await repository.createQuote(tenantId, {
          ...input,
          metadata,
          adImageKey,
          items,
          currency: issuer.currency,
          vatTreatment: issuer.vatTreatment,
          subtotal,
          vatRate: quoteTotals.rate,
          vatAmount: quoteTotals.amount,
          total: quoteTotals.total,
        });
        const entry = await appendAudit(deps.auditFor(db), {
          tenantId,
          action: "quote.created",
          entityType: "quote",
          entityId: quote.id,
          actorId: actor.actorId,
          actorName: actor.actorName,
          detailsJson: JSON.stringify({ quoteNumber: quote.quoteNumber }),
        });
        await deps.publish({
          name: "quote.created",
          tenantId,
          aggregateType: "quote",
          aggregateId: String(quote.id),
          payload: { quoteId: quote.id },
          idempotencyKey: `quote.created:${entry.hash}`,
        }, deps.eventExecutorFor(db));
        return quote;
      });
    },
    async sendQuote(tenantId: string, id: number, actor: Actor) {
      return transitionQuote(deps, tenantId, id, "draft", "sent", actor);
    },
    async declineQuote(tenantId: string, id: number, actor: Actor) {
      return transitionQuote(deps, tenantId, id, "sent", "declined", actor);
    },
    async acceptQuote(tenantId: string, id: number, actor: Actor) {
      return deps.transaction(async (db) => {
        const repository = deps.repositoryFor(db);
        const audit = deps.auditFor(db);
        const quote = await repository.getQuoteForUpdate(tenantId, id);
        if (!quote) throw new BillingDomainError("Angebot nicht gefunden");
        if (quote.invoiceId != null) {
          const invoice = await repository.getInvoice(tenantId, quote.invoiceId);
          if (!invoice) throw new BillingDomainError("Zugehörige Rechnung nicht gefunden");
          return invoice;
        }
        if (quote.status !== "sent") {
          throw new BillingDomainError("Nur versendete Angebote können angenommen werden");
        }
        const issuer = (await repository.listIssuers(tenantId)).find(
          (item) => item.id === quote.issuerId,
        );
        if (!issuer) throw new BillingDomainError("Aussteller nicht gefunden");
        const items = await repository.getQuoteItems(tenantId, id);
        const invoice = await createInvoiceInTransaction(deps, db, tenantId, {
          issuerId: quote.issuerId,
          customerId: quote.customerId ?? undefined,
          recipientName: quote.recipientName,
          recipientAddress: quote.recipientAddress ?? undefined,
          recipientEmail: quote.recipientEmail ?? undefined,
          currency: issuer.currency,
          vatTreatment: issuer.vatTreatment,
          subtotal: quote.subtotal,
          vatRate: quote.vatRate,
          vatAmount: quote.vatAmount,
          total: quote.total,
          dueDate: dueDate(new Date(), issuer.paymentTermDays),
          items: items.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            amount: item.amount,
            commissionRate: item.commissionRate ?? undefined,
            customerId: item.customerId ?? undefined,
          })),
        }, actor);
        await repository.setQuoteInvoiceId(tenantId, id, invoice.id);
        const accepted = await repository.setQuoteStatus(tenantId, id, "accepted");
        const entry = await appendAudit(audit, {
          tenantId,
          action: "quote.accepted",
          entityType: "quote",
          entityId: id,
          actorId: actor.actorId,
          actorName: actor.actorName,
          detailsJson: JSON.stringify({ invoiceId: invoice.id, quoteNumber: accepted.quoteNumber }),
        });
        await deps.publish({
          name: "quote.accepted",
          tenantId,
          aggregateType: "quote",
          aggregateId: String(id),
          payload: { quoteId: id, invoiceId: invoice.id },
          idempotencyKey: `quote.accepted:${entry.hash}`,
        }, deps.eventExecutorFor(db));
        return invoice;
      });
    },
    async quotePdf(tenantId: string, id: number) {
      const quote = await deps.repository.getQuote(tenantId, id);
      if (!quote) throw new BillingDomainError("Angebot nicht gefunden");
      const issuer = (await deps.repository.listIssuers(tenantId)).find(
        (item) => item.id === quote.issuerId,
      );
      if (!issuer) throw new BillingDomainError("Aussteller nicht gefunden");
      const items = await deps.repository.getQuoteItems(tenantId, id);
      return deps.pdf.quote({
        issuer,
        quote,
        items,
      });
    },
    async issueInvoice(tenantId: string, id: number, actor: Actor) {
      return deps.transaction(async (db) => {
        const repository = deps.repositoryFor(db);
        const audit = deps.auditFor(db);
        const current = await repository.getInvoice(tenantId, id);
        if (!current) throw new Error("Rechnung nicht gefunden");
        if (current.status !== "draft") {
          throw new Error("Nur Entwürfe können ausgestellt werden");
        }
        const issuer = (await repository.listIssuers(tenantId)).find(
          (item) => item.id === current.issuerId,
        );
        if (!issuer) throw new Error("Aussteller nicht gefunden");
        const issuedAt = new Date();
        const invoice = await repository.setInvoiceIssued(
          tenantId,
          id,
          issuedAt,
          dueDate(issuedAt, issuer.paymentTermDays),
        );
        const entry = await appendAudit(audit, {
          tenantId,
          action: "invoice.issued",
          entityType: "invoice",
          entityId: id,
          actorId: actor.actorId,
          actorName: actor.actorName,
          detailsJson: JSON.stringify({ invoiceNumber: invoice.invoiceNumber }),
        });
        await deps.publish(
          {
            name: "invoice.issued",
            tenantId,
            aggregateType: "invoice",
            aggregateId: String(id),
            payload: { invoiceId: id, invoiceNumber: invoice.invoiceNumber },
            idempotencyKey: `invoice.issued:${entry.hash}`,
          },
          deps.eventExecutorFor(db),
        );
        return invoice;
      });
    },
    async recordPayment(
      tenantId: string,
      id: number,
      input: {
        amount: string;
        paidAt: Date;
        reference?: string | undefined;
        note?: string | undefined;
      },
      actor: Actor,
    ) {
      return deps.transaction(async (db) => {
        const repository = deps.repositoryFor(db);
        const audit = deps.auditFor(db);
        const current = await repository.getInvoice(tenantId, id);
        if (!current) throw new Error("Rechnung nicht gefunden");
        if (!["issued", "partially_paid"].includes(current.status)) {
          throw new Error("Nur ausgestellte Rechnungen sind zahlbar");
        }
        const outstanding = addMoney(current.total, `-${current.paidAmount}`);
        if (addMoney(outstanding, `-${input.amount}`).startsWith("-")) {
          throw new Error("Zahlung übersteigt offenen Betrag");
        }
        const payment = await repository.addPayment(tenantId, id, {
          amount: input.amount,
          paidAt: input.paidAt,
          ...(input.reference ? { reference: input.reference } : {}),
          ...(input.note ? { note: input.note } : {}),
        });
        const entry = await appendAudit(audit, {
          tenantId,
          action: "payment.recorded",
          entityType: "invoice",
          entityId: id,
          actorId: actor.actorId,
          actorName: actor.actorName,
          detailsJson: JSON.stringify({
            paymentId: payment.id,
            amount: input.amount,
          }),
        });
        const updated = await repository.getInvoice(tenantId, id);
        const eventName =
          updated?.status === "paid"
            ? "invoice.paid"
            : "invoice.partially_paid";
        await deps.publish(
          {
            name: eventName,
            tenantId,
            aggregateType: "invoice",
            aggregateId: String(id),
            payload: { invoiceId: id, paymentId: payment.id },
            idempotencyKey: `${eventName}:${entry.hash}`,
          },
          deps.eventExecutorFor(db),
        );
        return payment;
      });
    },
    async runDunning(tenantId: string, actor: Actor) {
      const invoices = await deps.repository.listInvoices(tenantId);
      const levels = await deps.repository.listDunningLevels(tenantId);
      const entries = await deps.repository.listDunningEntries(tenantId);
      const created: unknown[] = [];
      for (const invoice of invoices) {
        if (
          !invoice.dueDate ||
          invoice.dueDate > new Date() ||
          !["issued", "partially_paid"].includes(invoice.status)
        )
          continue;
        const invoiceEntries = entries
          .filter((entry) => entry.invoiceId === invoice.id)
          .sort((left, right) => left.level - right.level);
        const lastEntry = invoiceEntries.at(-1);
        const level = levels
          .slice()
          .sort((left, right) => left.level - right.level)
          .find((item) => item.level > (lastEntry?.level ?? 0));
        if (!level) continue;
        const referenceDate = lastEntry?.createdAt ?? invoice.dueDate;
        const days = Math.floor(
          (Date.now() - referenceDate.getTime()) / 86_400_000,
        );
        if (days < level.daysAfterDue) continue;
        const outstanding = addMoney(invoice.total, `-${invoice.paidAmount}`);
        if (outstanding === "0.00") continue;
        const charges = dunningCharges(
          outstanding,
          days,
          level.feeAmount,
          level.interestRate,
        );
        const result = await deps.transaction(async (db) => {
          const repository = deps.repositoryFor(db);
          const audit = deps.auditFor(db);
          const entry = await repository.createDunningEntry(tenantId, {
            invoiceId: invoice.id,
            level: level.level,
            feeAmount: charges.fee,
            interestAmount: charges.interest,
            totalDue: charges.total,
            subject: level.subject,
            body: level.bodyTemplate.replace(
              "{invoiceNumber}",
              invoice.invoiceNumber,
            ),
          });
          const auditEntry = await appendAudit(audit, {
            tenantId,
            action: "dunning.issued",
            entityType: "invoice",
            entityId: invoice.id,
            actorId: actor.actorId,
            actorName: actor.actorName,
            detailsJson: JSON.stringify(charges),
          });
          await deps.publish(
            {
              name: "dunning.issued",
              tenantId,
              aggregateType: "invoice",
              aggregateId: String(invoice.id),
              payload: { dunningId: entry.id, level: level.level },
              idempotencyKey: `dunning.issued:${auditEntry.hash}`,
            },
            deps.eventExecutorFor(db),
          );
          return entry;
        });
        created.push(result);
      }
      return { created: created.length, entries: created };
    },
    async createCreditNote(
      tenantId: string,
      input: {
        issuerId: number;
        invoiceId?: number | undefined;
        amount: string;
        currency: "EUR" | "GBP";
        reason: string;
      },
      actor: Actor,
    ) {
      return deps.transaction(async (db) => {
        const repository = deps.repositoryFor(db);
        const number = await repository.nextCreditNumber(
          tenantId,
          input.issuerId,
        );
        await repository.createCreditNote({
          tenantId,
          ...input,
          creditNumber: number,
        });
        const entry = await appendAudit(deps.auditFor(db), {
          tenantId,
          action: "creditnote.created",
          entityType: "creditnote",
          entityId: number,
          actorId: actor.actorId,
          actorName: actor.actorName,
          detailsJson: JSON.stringify(input),
        });
        await deps.publish(
          {
            name: "creditnote.created",
            tenantId,
            aggregateType: "creditnote",
            aggregateId: number,
            payload: { creditNumber: number },
            idempotencyKey: `creditnote.created:${entry.hash}`,
          },
          deps.eventExecutorFor(db),
        );
        return { creditNumber: number };
      });
    },
    async invoicePdf(tenantId: string, id: number) {
      const invoice = await deps.repository.getInvoice(tenantId, id);
      if (!invoice) throw new Error("Rechnung nicht gefunden");
      const items = await deps.repository.getInvoiceItems(tenantId, id);
      const body = items
        .map(
          (item) =>
            `${item.position}. ${item.description} — ${item.amount} ${invoice.currency}`,
        )
        .join("\n");
      return deps.pdf.text(
        `Rechnung ${invoice.invoiceNumber}`,
        `${invoice.recipientName}\n\n${body}\n\nGesamt: ${invoice.total} ${invoice.currency}`,
      );
    },
  };
}

export type Actor = {
  actorId: string | number | null;
  actorName: string | null;
};

export type BillingService = ReturnType<typeof createBillingService>;
