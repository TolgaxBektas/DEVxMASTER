import {
  addMoney,
  annualInterest,
  multiplyMoney,
  percentMoney,
  vatFor,
} from "./money.js";

export const DEFAULT_PRICES = {
  af: "499.00",
  fp: "199.00",
  sp: "199.00",
} as const;

export const COMMISSION_RATES = ["35.00", "40.00"] as const;
export const DEFAULT_PAYMENT_TERM_DAYS = 14;

export function positionAmount(quantity: string, unitPrice: string): string {
  return multiplyMoney(unitPrice, quantity);
}

export function commission(amount: string, rate: string): string {
  return percentMoney(amount, rate);
}

export function advertisingAmount(
  afCount: string,
  afPrice = DEFAULT_PRICES.af,
  fpPrice = DEFAULT_PRICES.fp,
  spPrice = DEFAULT_PRICES.sp,
): string {
  return addMoney(multiplyMoney(afPrice, afCount), fpPrice, spPrice);
}

export function totals(subtotal: string, treatment: "RC" | "VAT19" | "VAT0") {
  return vatFor(subtotal, treatment);
}

export function dueDate(
  issueDate: Date,
  days = DEFAULT_PAYMENT_TERM_DAYS,
): Date {
  return new Date(issueDate.getTime() + days * 86_400_000);
}

export function invoiceNumber(
  prefix: string,
  year: number,
  sequence: number,
): string {
  return `${prefix}-${year}-${String(sequence).padStart(4, "0")}`;
}

export function dunningCharges(
  outstanding: string,
  daysOverdue: number,
  fee: string,
  annualRate: string,
) {
  const interest = annualInterest(outstanding, annualRate, daysOverdue);
  return {
    fee,
    interest,
    total: addMoney(outstanding, fee, interest),
  };
}
