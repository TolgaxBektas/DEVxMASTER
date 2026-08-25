import { invoiceNumber, quoteNumber } from "./formulas.js";
import type {
  DunningEntry,
  Invoice,
  InvoiceItem,
  Issuer,
  Payment,
  Quote,
  QuoteItem,
} from "./types.js";
import type {
  BillingRepository,
  CreateInvoiceInput,
  CreateQuoteInput,
} from "./repository.js";

export class MemoryBillingRepository implements BillingRepository {
  issuers: Issuer[] = [];
  invoices: Invoice[] = [];
  items: InvoiceItem[] = [];
  quotes: Quote[] = [];
  quoteItems: QuoteItem[] = [];
  payments: Payment[] = [];
  dunning: DunningEntry[] = [];
  private issuerId = 0;
  private invoiceId = 0;
  private quoteId = 0;
  private itemId = 0;
  private quoteItemId = 0;
  private paymentId = 0;
  private dunningId = 0;
  private creditSequence = 0;

  async listIssuers(tenantId: string) {
    return this.issuers.filter((item) => item.tenantId === tenantId);
  }

  async createIssuer(
    tenantId: string,
    input: import("./repository.js").CreateIssuerInput,
  ) {
    const issuer: Issuer = {
      ...input,
      id: ++this.issuerId,
      tenantId,
      nextNumber: 1,
      numberYear: null,
      quotePrefix: input.quotePrefix ?? null,
      nextQuoteNumber: 1,
      quoteNumberYear: null,
      paymentTermDays: input.paymentTermDays ?? 14,
      address: input.address ?? null,
      email: input.email ?? null,
      bankName: input.bankName ?? null,
      iban: input.iban ?? null,
      bic: input.bic ?? null,
      letterhead: input.letterhead ?? null,
    };
    this.issuers.push(issuer);
    return issuer;
  }

  async listInvoices(tenantId: string) {
    return this.invoices.filter((item) => item.tenantId === tenantId);
  }

  async listQuotes(tenantId: string) {
    return this.quotes.filter((item) => item.tenantId === tenantId);
  }

  async getQuote(tenantId: string, id: number) {
    return this.quotes.find(
      (item) => item.tenantId === tenantId && item.id === id,
    ) ?? null;
  }

  async getQuoteForUpdate(tenantId: string, id: number) {
    return this.getQuote(tenantId, id);
  }

  async getQuoteItems(_tenantId: string, id: number) {
    return this.quoteItems.filter((item) => item.quoteId === id);
  }

  async createQuote(tenantId: string, input: CreateQuoteInput) {
    const issuer = this.issuers.find(
      (item) => item.id === input.issuerId && item.tenantId === tenantId,
    );
    if (!issuer) throw new Error("Aussteller nicht gefunden");
    const year = new Date().getFullYear();
    if (issuer.quoteNumberYear !== year) {
      issuer.quoteNumberYear = year;
      issuer.nextQuoteNumber = 1;
    }
    const number = issuer.nextQuoteNumber++;
    const quote: Quote = {
      id: ++this.quoteId,
      tenantId,
      issuerId: issuer.id,
      customerId: input.customerId ?? null,
      occurrenceId: input.occurrenceId ?? null,
      adImageKey: input.adImageKey ?? null,
      quoteNumber: quoteNumber(
        issuer.quotePrefix ?? `AG-${issuer.invoicePrefix}`,
        year,
        number,
      ),
      status: "draft",
      currency: input.currency,
      vatTreatment: input.vatTreatment,
      subtotal: input.subtotal,
      vatRate: input.vatRate,
      vatAmount: input.vatAmount,
      total: input.total,
      validUntil: input.validUntil ?? null,
      recipientName: input.recipientName,
      recipientAddress: input.recipientAddress ?? null,
      recipientEmail: input.recipientEmail ?? null,
      invoiceId: null,
      notes: input.notes ?? null,
      metadata: input.metadata ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.quotes.push(quote);
    this.quoteItems.push(
      ...input.items.map((item, index) => ({
        ...item,
        id: ++this.quoteItemId,
        quoteId: quote.id,
        position: index + 1,
        commissionRate: item.commissionRate ?? null,
        customerId: item.customerId ?? null,
      })),
    );
    return quote;
  }

  async setQuoteStatus(tenantId: string, id: number, status: Quote["status"]) {
    const quote = await this.getQuote(tenantId, id);
    if (!quote) throw new Error("Angebot nicht gefunden");
    quote.status = status;
    quote.updatedAt = new Date();
    return quote;
  }

  async setQuoteInvoiceId(tenantId: string, id: number, invoiceId: number) {
    const quote = await this.getQuote(tenantId, id);
    if (!quote) throw new Error("Angebot nicht gefunden");
    if (quote.invoiceId == null) quote.invoiceId = invoiceId;
    quote.updatedAt = new Date();
    return quote;
  }

  async getInvoice(tenantId: string, id: number) {
    return (
      this.invoices.find(
        (item) => item.tenantId === tenantId && item.id === id,
      ) ?? null
    );
  }

  async getInvoiceItems(_tenantId: string, id: number) {
    return this.items.filter((item) => item.invoiceId === id);
  }

  async createInvoice(tenantId: string, input: CreateInvoiceInput) {
    const issuer = this.issuers.find(
      (item) => item.id === input.issuerId && item.tenantId === tenantId,
    );
    if (!issuer) throw new Error("Aussteller nicht gefunden");
    const year = new Date().getFullYear();
    if (issuer.numberYear !== year) {
      issuer.numberYear = year;
      issuer.nextNumber = 1;
    }
    const number = issuer.nextNumber++;
    const invoice: Invoice = {
      id: ++this.invoiceId,
      tenantId,
      issuerId: issuer.id,
      customerId: input.customerId ?? null,
      invoiceNumber: invoiceNumber(issuer.invoicePrefix, year, number),
      status: "draft",
      currency: input.currency,
      vatTreatment: input.vatTreatment,
      subtotal: input.subtotal,
      vatRate: input.vatRate,
      vatAmount: input.vatAmount,
      total: input.total,
      paidAmount: "0.00",
      issueDate: null,
      dueDate: input.dueDate,
      recipientName: input.recipientName,
      recipientAddress: input.recipientAddress ?? null,
      recipientEmail: input.recipientEmail ?? null,
    };
    this.invoices.push(invoice);
    this.items.push(
      ...input.items.map((item, index) => ({
        ...item,
        id: ++this.itemId,
        invoiceId: invoice.id,
        position: index + 1,
        commissionRate: item.commissionRate ?? null,
      })),
    );
    return invoice;
  }

  async setInvoiceIssued(
    tenantId: string,
    id: number,
    issueDate: Date,
    dueDate: Date,
  ) {
    const invoice = await this.getInvoice(tenantId, id);
    if (!invoice) throw new Error("Rechnung nicht gefunden");
    if (invoice.status !== "draft")
      throw new Error("Nur Entwürfe können ausgestellt werden");
    invoice.status = "issued";
    invoice.issueDate = issueDate;
    invoice.dueDate = dueDate;
    return invoice;
  }

  async addPayment(
    tenantId: string,
    id: number,
    input: Omit<Payment, "id" | "invoiceId">,
  ) {
    const invoice = await this.getInvoice(tenantId, id);
    if (!invoice || !["issued", "partially_paid"].includes(invoice.status)) {
      throw new Error("Rechnung ist nicht zahlbar");
    }
    const payment = { ...input, id: ++this.paymentId, invoiceId: id };
    this.payments.push(payment);
    invoice.paidAmount = add(invoice.paidAmount, input.amount);
    invoice.status =
      invoice.paidAmount === invoice.total ? "paid" : "partially_paid";
    return payment;
  }

  async listPayments(tenantId: string, id: number) {
    const invoice = await this.getInvoice(tenantId, id);
    return invoice ? this.payments.filter((item) => item.invoiceId === id) : [];
  }

  async listDunningLevels(_tenantId: string) {
    return [
      {
        level: 1,
        daysAfterDue: 0,
        feeAmount: "5.00",
        interestRate: "5.00",
        subject: "Zahlungserinnerung",
        bodyTemplate: "Bitte zahlen.",
      },
    ];
  }

  async listDunningEntries(tenantId: string) {
    return this.dunning.filter((item) =>
      this.invoices.find(
        (invoice) =>
          invoice.id === item.invoiceId && invoice.tenantId === tenantId,
      ),
    );
  }

  async createDunningEntry(_tenantId: string, entry: Omit<DunningEntry, "id">) {
    const result = { ...entry, id: ++this.dunningId, createdAt: new Date() };
    this.dunning.push(result);
    return result;
  }

  async nextCreditNumber(tenantId: string, issuerId: number) {
    const issuer = this.issuers.find(
      (item) => item.tenantId === tenantId && item.id === issuerId,
    );
    if (!issuer) throw new Error("Aussteller nicht gefunden");
    return invoiceNumber(
      `GS-${issuer.invoicePrefix}`,
      new Date().getFullYear(),
      ++this.creditSequence,
    );
  }

  async createCreditNote() {}
}

function add(left: string, right: string): string {
  const parse = (value: string) => BigInt(value.replace(".", ""));
  return (parse(left) + parse(right))
    .toString()
    .padStart(3, "0")
    .replace(/(\d{2})$/, ".$1");
}
