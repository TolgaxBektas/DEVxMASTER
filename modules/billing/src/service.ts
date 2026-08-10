import {
  appendAudit,
  type AuditRepository,
  type EventExecutor,
} from "@xmaster-center/kernel";
import type { Pdf } from "@xmaster-center/integrations";
import { dunningCharges, dueDate, totals } from "./formulas.js";
import type {
  BillingRepository,
  CreateInvoiceInput,
  CreateIssuerInput,
} from "./repository.js";

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
};

export function createBillingService(deps: BillingServiceDeps) {
  return {
    listIssuers: (tenantId: string) => deps.repository.listIssuers(tenantId),
    listInvoices: (tenantId: string) => deps.repository.listInvoices(tenantId),
    listDunningEntries: (tenantId: string) =>
      deps.repository.listDunningEntries(tenantId),
    getInvoice: (tenantId: string, id: number) =>
      deps.repository.getInvoice(tenantId, id),
    async createIssuer(tenantId: string, input: CreateIssuerInput) {
      return deps.transaction(async (db) => {
        const repository = deps.repositoryFor(db);
        const audit = deps.auditFor(db);
        const issuer = await repository.createIssuer(tenantId, input);
        await appendAudit(audit, {
          tenantId,
          action: "issuer.created",
          entityType: "issuer",
          entityId: issuer.id,
          actorId: null,
          actorName: null,
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
        const repository = deps.repositoryFor(db);
        const audit = deps.auditFor(db);
        const issuer = (await repository.listIssuers(tenantId)).find(
          (item) => item.id === input.issuerId,
        );
        if (!issuer) throw new Error("Aussteller nicht gefunden");
        const invoiceTotals = totals(input.subtotal, issuer.vatTreatment);
        const adjustedInput = {
          ...input,
          currency: issuer.currency,
          vatTreatment: issuer.vatTreatment,
          vatRate: invoiceTotals.rate,
          vatAmount: invoiceTotals.amount,
          total: invoiceTotals.total,
        };
        const invoice = await repository.createInvoice(tenantId, adjustedInput);
        const entry = await appendAudit(audit, {
          tenantId,
          action: "invoice.created",
          entityType: "invoice",
          entityId: invoice.id,
          actorId: actor.actorId,
          actorName: actor.actorName,
          detailsJson: JSON.stringify({ invoiceNumber: invoice.invoiceNumber }),
        });
        await deps.publish(
          {
            name: "invoice.created",
            tenantId,
            aggregateType: "invoice",
            aggregateId: String(invoice.id),
            payload: { invoiceId: invoice.id },
            idempotencyKey: `invoice.created:${entry.hash}`,
          },
          deps.eventExecutorFor(db),
        );
        return invoice;
      });
    },
    async issueInvoice(tenantId: string, id: number, actor: Actor) {
      return deps.transaction(async (db) => {
        const repository = deps.repositoryFor(db);
        const audit = deps.auditFor(db);
        const current = await repository.getInvoice(tenantId, id);
        if (!current) throw new Error("Rechnung nicht gefunden");
        const issuedAt = new Date();
        const invoice = await repository.setInvoiceIssued(
          tenantId,
          id,
          issuedAt,
          dueDate(issuedAt),
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
        await deps.publish(
          {
            name: "invoice.paid",
            tenantId,
            aggregateType: "invoice",
            aggregateId: String(id),
            payload: { invoiceId: id, paymentId: payment.id },
            idempotencyKey: `invoice.paid:${entry.hash}`,
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
        const level = levels.find(
          (item) =>
            !entries.some(
              (entry) =>
                entry.invoiceId === invoice.id && entry.level === item.level,
            ),
        );
        if (!level) continue;
        const days = Math.floor(
          (Date.now() - invoice.dueDate.getTime()) / 86_400_000,
        );
        const charges = dunningCharges(
          invoice.total,
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
