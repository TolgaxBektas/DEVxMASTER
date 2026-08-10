import type { EventExecutor } from "@xmaster-center/kernel";
import type {
  DunningEntry,
  Invoice,
  InvoiceItem,
  Issuer,
  Payment,
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
  bankName?: string | undefined;
  iban?: string | undefined;
  bic?: string | undefined;
  logoUrl?: string | undefined;
  letterhead?: string | undefined;
  currency: "EUR" | "GBP";
  vatTreatment: "RC" | "VAT19" | "VAT0";
};

export type BillingRepository = {
  listIssuers(tenantId: string): Promise<Issuer[]>;
  createIssuer(tenantId: string, input: CreateIssuerInput): Promise<Issuer>;
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
