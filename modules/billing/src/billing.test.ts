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
import { annualInterest, multiplyMoney, percentMoney } from "./money.js";

function service(
  repository: MemoryBillingRepository,
  audit: MemoryAuditRepository,
  events: string[] = [],
  resolveAdSource?: (
    tenantId: string,
    occurrenceId: number,
  ) => Promise<{ imageKey: string | null; company: string } | null>,
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
    publish: async (input) => {
      events.push(input.name);
      return undefined;
    },
    pdf: new NoopPdf(),
    ...(resolveAdSource ? { resolveAdSource } : {}),
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

  it("rounds negative values symmetrically and keeps interest precision", () => {
    expect(multiplyMoney("-1.00", "0.51")).toBe("-0.51");
    expect(percentMoney("-1.00", "50.50")).toBe("-0.51");
    expect(annualInterest("100.00", "8.00", 30)).toBe("0.66");
  });

  it("rejects silent precision loss and exhausted invoice numbers", () => {
    expect(() => multiplyMoney("1.005", "1.00")).toThrow();
    expect(() => invoiceNumber("QNT", 2026, 10000)).toThrow();
  });
});

describe("billing service", () => {
  async function quoteFixture(
    tenantId = "1",
    treatment: "RC" | "VAT19" | "VAT0" = "VAT19",
    events: string[] = [],
    resolveAdSource?: (
      tenantId: string,
      occurrenceId: number,
    ) => Promise<{ imageKey: string | null; company: string } | null>,
  ) {
    const repository = new MemoryBillingRepository();
    const audit = new MemoryAuditRepository();
    const billing = service(repository, audit, events, resolveAdSource);
    const issuer = await billing.createIssuer(tenantId, {
      name: "Quantia GmbH",
      invoicePrefix: "QNT",
      currency: "EUR",
      vatTreatment: treatment,
    }, { actorId: "1", actorName: "Admin" });
    const quote = await billing.createQuote(tenantId, {
      issuerId: issuer.id,
      recipientName: "Kunde",
      items: [{ description: "Anzeige", quantity: "1.00", unitPrice: "100.00" }],
    }, { actorId: "1", actorName: "Admin" });
    return { repository, audit, billing, issuer, quote };
  }

  it("creates quote numbers with fallback prefix and resets the year", async () => {
    const fixture = await quoteFixture();
    expect(fixture.quote.quoteNumber).toMatch(/^AG-QNT-\d{4}-0001$/);
    fixture.issuer.quoteNumberYear = new Date().getFullYear() - 1;
    fixture.issuer.nextQuoteNumber = 42;
    const next = await fixture.billing.createQuote("1", {
      issuerId: fixture.issuer.id,
      recipientName: "Kunde",
      items: [{ description: "Anzeige", quantity: "1.00", unitPrice: "10.00" }],
    }, { actorId: "1", actorName: "Admin" });
    expect(next.quoteNumber).toMatch(/-0001$/);
  });

  it.each([
    ["RC", "0.00", "100.00"],
    ["VAT0", "0.00", "100.00"],
    ["VAT19", "19.00", "119.00"],
  ] as const)("calculates quote totals for %s", async (treatment, vatAmount, total) => {
    const { quote } = await quoteFixture("1", treatment);
    expect(quote.subtotal).toBe("100.00");
    expect(quote.vatAmount).toBe(vatAmount);
    expect(quote.total).toBe(total);
  });

  it("enforces quote transitions and creates one invoice on acceptance", async () => {
    const events: string[] = [];
    const fixture = await quoteFixture("1", "VAT19", events);
    await expect(fixture.billing.acceptQuote("1", fixture.quote.id, { actorId: "1", actorName: "Admin" }))
      .rejects.toThrow("versendete");
    await fixture.billing.sendQuote("1", fixture.quote.id, { actorId: "1", actorName: "Admin" });
    await expect(fixture.billing.sendQuote("1", fixture.quote.id, { actorId: "1", actorName: "Admin" }))
      .rejects.toThrow("Entwürfe");
    const invoices = await Promise.all([
      fixture.billing.acceptQuote("1", fixture.quote.id, { actorId: "1", actorName: "Admin" }),
      fixture.billing.acceptQuote("1", fixture.quote.id, { actorId: "1", actorName: "Admin" }),
    ]);
    expect(invoices[0].id).toBe(invoices[1].id);
    expect(fixture.repository.invoices).toHaveLength(1);
    expect((await fixture.billing.getQuote("1", fixture.quote.id))?.status).toBe("accepted");
    expect(events).toEqual(expect.arrayContaining(["quote.created", "quote.sent", "quote.accepted"]));
    await expect(fixture.billing.declineQuote("1", fixture.quote.id, { actorId: "1", actorName: "Admin" }))
      .rejects.toThrow("versendete");
  });

  it("rejects unknown and foreign occurrence ids without creating quotes", async () => {
    const repository = new MemoryBillingRepository();
    const audit = new MemoryAuditRepository();
    const sources = new Map([[7, { imageKey: "ad.png", company: "Firma" }]]);
    const billing = service(repository, audit, [], async (tenantId, id) =>
      tenantId === "1" ? sources.get(id) ?? null : null,
    );
    const issuer = await billing.createIssuer("1", {
      name: "Quantia GmbH", invoicePrefix: "QNT", currency: "EUR", vatTreatment: "RC",
    }, { actorId: "1", actorName: "Admin" });
    const foreignIssuer = await billing.createIssuer("2", {
      name: "Andere GmbH", invoicePrefix: "AND", currency: "EUR", vatTreatment: "RC",
    }, { actorId: "2", actorName: "Other" });
    const input = {
      issuerId: issuer.id,
      recipientName: "Kunde",
      occurrenceId: 7,
      items: [{ description: "Anzeige", quantity: "1.00", unitPrice: "10.00" }],
    };
    await expect(billing.createQuote("1", { ...input, occurrenceId: 8 }, { actorId: "1", actorName: "Admin" }))
      .rejects.toThrow("Fundstelle nicht gefunden");
    await expect(billing.createQuote("2", { ...input, issuerId: foreignIssuer.id }, { actorId: "2", actorName: "Other" }))
      .rejects.toThrow("Fundstelle nicht gefunden");
    expect(repository.quotes).toHaveLength(0);
  });

  it("keeps quote tenant isolation", async () => {
    const repository = new MemoryBillingRepository();
    const audit = new MemoryAuditRepository();
    const billing = service(repository, audit);
    const issuer = await billing.createIssuer("1", {
      name: "Quantia GmbH", invoicePrefix: "QNT", currency: "EUR", vatTreatment: "RC",
    }, { actorId: "1", actorName: "Admin" });
    const quote = await billing.createQuote("1", {
      issuerId: issuer.id, recipientName: "Kunde",
      items: [{ description: "Anzeige", quantity: "1.00", unitPrice: "10.00" }],
    }, { actorId: "1", actorName: "Admin" });
    expect(await billing.getQuote("2", quote.id)).toBeNull();
    await expect(billing.acceptQuote("2", quote.id, { actorId: "2", actorName: "Other" }))
      .rejects.toThrow("Angebot nicht gefunden");
  });

  it("creates, issues, pays and refuses a second issue", async () => {
    const repository = new MemoryBillingRepository();
    const audit = new MemoryAuditRepository();
    const events: string[] = [];
    const billing = service(repository, audit, events);
    const issuer = await billing.createIssuer("1", {
      name: "Quantia GmbH",
      invoicePrefix: "QNT",
      currency: "EUR",
      vatTreatment: "VAT19",
    }, { actorId: "1", actorName: "Admin" });
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
      { amount: "20.00", paidAt: new Date() },
      { actorId: "1", actorName: "Admin" },
    );
    expect((await billing.getInvoice("1", invoice.id))?.status).toBe(
      "partially_paid",
    );
    expect(events).toContain("invoice.partially_paid");
    await billing.recordPayment(
      "1",
      invoice.id,
      { amount: "99.00", paidAt: new Date() },
      { actorId: "1", actorName: "Admin" },
    );
    expect((await billing.getInvoice("1", invoice.id))?.status).toBe("paid");
    expect(events).toContain("invoice.paid");
    await expect(
      billing.recordPayment(
        "1",
        invoice.id,
        { amount: "1.00", paidAt: new Date() },
        { actorId: "1", actorName: "Admin" },
      ),
    ).rejects.toThrow();
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
    }, { actorId: "1", actorName: "Admin" });
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
    await billing.recordPayment(
      "1",
      invoice.id,
      { amount: "40.00", paidAt: new Date() },
      { actorId: "1", actorName: "Admin" },
    );
    const result = await billing.runDunning("1", {
      actorId: "1",
      actorName: "Admin",
    });
    expect(result.created).toBe(1);
    expect(await billing.listDunningEntries("1")).toHaveLength(1);
    expect((await billing.listDunningEntries("1"))[0]?.totalDue).toBe("65.02");
    expect(
      audit.entries.some((entry) => entry.action === "dunning.issued"),
    ).toBe(true);
    const second = await billing.runDunning("1", {
      actorId: "1",
      actorName: "Admin",
    });
    expect(second.created).toBe(0);
  });

  it("rejects payment on drafts and recalculates invoice totals from items", async () => {
    const repository = new MemoryBillingRepository();
    const audit = new MemoryAuditRepository();
    const billing = service(repository, audit);
    const issuer = await billing.createIssuer("1", {
      name: "Quantia", invoicePrefix: "QNT", currency: "EUR", vatTreatment: "VAT19",
    }, { actorId: "1", actorName: "Admin" });
    const invoice = await billing.createInvoice("1", {
      issuerId: issuer.id, recipientName: "Kunde", currency: "EUR", vatTreatment: "VAT19",
      subtotal: "9999.00", vatRate: "0.00", vatAmount: "0.00", total: "9999.00",
      dueDate: new Date(), items: [{ description: "A", quantity: "2.00", unitPrice: "10.00", amount: "9999.00" }],
    }, { actorId: "1", actorName: "Admin" });
    expect(invoice.subtotal).toBe("20.00");
    expect(invoice.total).toBe("23.80");
    await expect(billing.recordPayment("1", invoice.id, {
      amount: "1.00", paidAt: new Date(),
    }, { actorId: "1", actorName: "Admin" })).rejects.toThrow();
  });

  it("allocates unique numbers for concurrent draft creation", async () => {
    const repository = new MemoryBillingRepository();
    const audit = new MemoryAuditRepository();
    const billing = service(repository, audit);
    const issuer = await billing.createIssuer("1", {
      name: "Concurrent", invoicePrefix: "CON", currency: "EUR", vatTreatment: "RC",
    }, { actorId: "1", actorName: "Admin" });
    const input = {
      issuerId: issuer.id, recipientName: "Kunde", currency: "EUR" as const,
      vatTreatment: "RC" as const, subtotal: "1.00", vatRate: "0.00",
      vatAmount: "0.00", total: "1.00", dueDate: new Date(),
      items: [{ description: "A", quantity: "1.00", unitPrice: "1.00", amount: "1.00" }],
    };
    const invoices = await Promise.all([
      billing.createInvoice("1", input, { actorId: "1", actorName: "Admin" }),
      billing.createInvoice("1", input, { actorId: "1", actorName: "Admin" }),
    ]);
    expect(new Set(invoices.map((item) => item.invoiceNumber)).size).toBe(2);
  });
});
