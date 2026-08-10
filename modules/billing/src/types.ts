import type { Currency } from "./money.js";

export type Issuer = {
  id: number;
  tenantId: string;
  name: string;
  address: string | null;
  email: string | null;
  invoicePrefix: string;
  nextNumber: number;
  numberYear: number | null;
  paymentTermDays: number;
  bankName: string | null;
  iban: string | null;
  bic: string | null;
  letterhead: string | null;
  currency: Currency;
  vatTreatment: "RC" | "VAT19" | "VAT0";
};

export type InvoiceStatus =
  | "draft"
  | "issued"
  | "partially_paid"
  | "paid"
  | "cancelled";

export type InvoiceItem = {
  id: number;
  invoiceId: number;
  position: number;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  commissionRate: string | null;
};

export type Invoice = {
  id: number;
  tenantId: string;
  issuerId: number;
  customerId: number | null;
  invoiceNumber: string;
  status: InvoiceStatus;
  currency: Currency;
  vatTreatment: "RC" | "VAT19" | "VAT0";
  subtotal: string;
  vatRate: string;
  vatAmount: string;
  total: string;
  paidAmount: string;
  issueDate: Date | null;
  dueDate: Date | null;
  recipientName: string;
  recipientAddress: string | null;
  recipientEmail: string | null;
};

export type Payment = {
  id: number;
  invoiceId: number;
  amount: string;
  paidAt: Date;
  reference?: string | null;
  note?: string | null;
};

export type DunningEntry = {
  id: number;
  invoiceId: number;
  level: number;
  feeAmount: string;
  interestAmount: string;
  totalDue: string;
  subject: string;
  body: string;
  createdAt?: Date;
};
