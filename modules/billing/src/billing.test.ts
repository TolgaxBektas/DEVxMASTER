import { describe, expect, it } from "vitest";
import { MemoryAuditRepository, appendAudit } from "@xmaster-center/kernel";
import { NoopPdf } from "@xmaster-center/integrations";
import {
  advertisingAmount,
  commission,
  dunningCharges,
  invoiceNumber,
} from "./formulas.js";
import { MemoryBillingRepository } from "./memory-repository.js";
import { createBillingService } from "./service.js";

function service(
  repository: MemoryBillingRepository,
  audit: MemoryAuditRepository,
) {
  return createBillingService({
    repository,
    repositoryFor: () => repository,
    audit,
    auditFor: () => audit,
    transaction: async (callback) => callback(repository),
    eventExecutorFor: () => ({
      append: async (event: {
        id: string;
        name: string;
        tenantId: string;
        occurredAt: Date;
        aggregateType: string;
        aggregateId: string | number;
        payload: Record<string, unknown>;
        idempotencyKey: string;
      }) => event,
    }),
    publish: async () => undefined,
    pdf: new NoopPdf(),
  });
}

describe("billing formulas", () => {
  it("keeps the verified price and commission semantics in decimal strings", () => {
    expect(advertisingAmount("2.00")).toBe("1396.00");
  });

  it("formats invoice numbers across years", () => {
    expect(invoiceNumber("QNT", 2026, 7)).toBe("QNT-2026-0007");
    expect(commission("1394.00", "35.00")).toBe("487.90");
  });

  it("calculates dunning fee and annual interest", () => {
    expect(dunningCharges("100.00", 365, "5.00", "5.00")).toEqual({
      fee: "5.00",
      interest: "5.00",
      total: "110.00",
    });
  });
});

describe("billing service", () => {
  it("creates, issues, pays and refuses a second issue", async () => {
    const repository = new MemoryBillingRepository();
    const audit = new MemoryAuditRepository();
    const billing = service(repository, audit);
    const issuer = await billing.createIssuer("1", {
      name: "Quantia GmbH",
      invoicePrefix: "QNT",
      currency: "EUR",
      vatTreatment: "VAT19",
    });
    const invoice = await billing.createInvoice(
      "1",
      {
        issuerId: issuer.id,
        recipientName: "Kunde",
        currency: "EUR",
        vatTreatment: "VAT19",
        subtotal: "100.00",
        vatRate: "19.00",
        vatAmount: "19.00",
        total: "119.00",
        dueDate: new Date(),
        items: [
          {
            description: "Leistung",
            quantity: "1.00",
            unitPrice: "100.00",
            amount: "100.00",
          },
        ],
      },
      { actorId: "1", actorName: "Admin" },
    );
    await billing.issueInvoice("1", invoice.id, {
      actorId: "1",
      actorName: "Admin",
    });
    await expect(
      billing.issueInvoice("1", invoice.id, {
        actorId: "1",
        actorName: "Admin",
      }),
    ).rejects.toThrow();
    await billing.recordPayment(
      "1",
      invoice.id,
      { amount: "119.00", paidAt: new Date() },
      { actorId: "1", actorName: "Admin" },
    );
    expect((await billing.getInvoice("1", invoice.id))?.status).toBe("paid");
  });

  it("creates one dunning entry for an overdue invoice", async () => {
    const repository = new MemoryBillingRepository();
    const audit = new MemoryAuditRepository();
    const billing = service(repository, audit);
    const issuer = await billing.createIssuer("1", {
      name: "Baleo",
      invoicePrefix: "BAL",
      currency: "GBP",
      vatTreatment: "RC",
    });
    const invoice = await billing.createInvoice(
      "1",
      {
        issuerId: issuer.id,
        recipientName: "Partner",
        currency: "GBP",
        vatTreatment: "RC",
        subtotal: "100.00",
        vatRate: "0.00",
        vatAmount: "0.00",
        total: "100.00",
        dueDate: new Date(Date.now() - 3 * 86_400_000),
        items: [
          {
            description: "Provision",
            quantity: "1.00",
            unitPrice: "100.00",
            amount: "100.00",
          },
        ],
      },
      { actorId: "1", actorName: "Admin" },
    );
    await billing.issueInvoice("1", invoice.id, {
      actorId: "1",
      actorName: "Admin",
    });
    invoice.dueDate = new Date(Date.now() - 3 * 86_400_000);
    const result = await billing.runDunning("1", {
      actorId: "1",
      actorName: "Admin",
    });
    expect(result.created).toBe(1);
    expect(await billing.listDunningEntries("1")).toHaveLength(1);
    expect(
      audit.entries.some((entry) => entry.action === "dunning.issued"),
    ).toBe(true);
  });
});
