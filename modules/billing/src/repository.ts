import type { EventExecutor } from "@xmaster-center/kernel";
import type {
  DunningEntry,
  Invoice,
  InvoiceItem,
  Issuer,
  Payment,
  Quote,
  QuoteItem,
} from "./types.js";

export type CreateInvoiceInput = {
  issuerId: number;
  customerId?: number | undefined;
  recipientName: string;
  recipientAddress?: string | undefined;
  recipientEmail?: string | undefined;
  currency: "EUR" | "GBP";
  vatTreatment: "RC" | "VAT19" | "VAT0";
  subtotal: string;
  vatRate: string;
  vatAmount: string;
  total: string;
  dueDate: Date;
  items: Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    commissionRate?: string | undefined;
    customerId?: number | undefined;
  }>;
};

export type CreateIssuerInput = {
  name: string;
  address?: string | undefined;
  email?: string | undefined;
  invoicePrefix: string;
  quotePrefix?: string | undefined;
  bankName?: string | undefined;
  iban?: string | undefined;
  bic?: string | undefined;
  logoUrl?: string | undefined;
  letterhead?: string | undefined;
  paymentTermDays?: number | undefined;
  currency: "EUR" | "GBP";
  vatTreatment: "RC" | "VAT19" | "VAT0";
};

export type CreateQuoteInput = {
  issuerId: number;
  customerId?: number | undefined;
  occurrenceId?: number | undefined;
  adImageKey?: string | null | undefined;
  recipientName: string;
  recipientAddress?: string | undefined;
  recipientEmail?: string | undefined;
  currency: "EUR" | "GBP";
  vatTreatment: "RC" | "VAT19" | "VAT0";
  subtotal: string;
  vatRate: string;
  vatAmount: string;
  total: string;
  validUntil?: Date | undefined;
  notes?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  items: Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    commissionRate?: string | undefined;
    customerId?: number | undefined;
  }>;
};

export type BillingRepository = {
  listIssuers(tenantId: string): Promise<Issuer[]>;
  createIssuer(tenantId: string, input: CreateIssuerInput): Promise<Issuer>;
  listQuotes(tenantId: string): Promise<Quote[]>;
  getQuote(tenantId: string, id: number): Promise<Quote | null>;
  getQuoteForUpdate(tenantId: string, id: number): Promise<Quote | null>;
  getQuoteItems(tenantId: string, id: number): Promise<QuoteItem[]>;
  createQuote(tenantId: string, input: CreateQuoteInput): Promise<Quote>;
  setQuoteStatus(tenantId: string, id: number, status: Quote["status"]): Promise<Quote>;
  setQuoteInvoiceId(tenantId: string, id: number, invoiceId: number): Promise<Quote>;
  listInvoices(tenantId: string): Promise<Invoice[]>;
  getInvoice(tenantId: string, id: number): Promise<Invoice | null>;
  getInvoiceItems(tenantId: string, id: number): Promise<InvoiceItem[]>;
  createInvoice(tenantId: string, input: CreateInvoiceInput): Promise<Invoice>;
  setInvoiceIssued(
    tenantId: string,
    id: number,
    issueDate: Date,
    dueDate: Date,
  ): Promise<Invoice>;
  addPayment(
    tenantId: string,
    id: number,
    payment: Omit<Payment, "id" | "invoiceId">,
  ): Promise<Payment>;
  listPayments(tenantId: string, id: number): Promise<Payment[]>;
  listDunningLevels(tenantId: string): Promise<
    Array<{
      level: number;
      daysAfterDue: number;
      feeAmount: string;
      interestRate: string;
      subject: string;
      bodyTemplate: string;
    }>
  >;
  listDunningEntries(tenantId: string): Promise<DunningEntry[]>;
  createDunningEntry(
    tenantId: string,
    entry: Omit<DunningEntry, "id">,
  ): Promise<DunningEntry>;
  nextCreditNumber(tenantId: string, issuerId: number): Promise<string>;
  createCreditNote(input: {
    tenantId: string;
    issuerId: number;
    invoiceId?: number | undefined;
    creditNumber: string;
    amount: string;
    currency: "EUR" | "GBP";
    reason: string;
  }): Promise<void>;
};

export type BillingTransaction = {
  repository: BillingRepository;
  audit: EventExecutor;
};
