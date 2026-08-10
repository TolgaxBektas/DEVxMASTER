export type Currency = "EUR" | "GBP";

function scaled(value: string, digits: number): bigint {
  const normalized = value.trim().replace(",", ".");
  const sign = normalized.startsWith("-") ? -1n : 1n;
  const unsigned = normalized.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  const padded = (fraction + "0".repeat(digits)).slice(0, digits);
  return (
    sign *
    (BigInt(whole || "0") * 10n ** BigInt(digits) + BigInt(padded || "0"))
  );
}

function decimal(value: bigint, digits: number): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const base = 10n ** BigInt(digits);
  const whole = absolute / base;
  const fraction = String(absolute % base).padStart(digits, "0");
  return `${sign}${whole}.${fraction}`;
}

export function cents(value: string): bigint {
  return scaled(value, 2);
}

export function money(value: bigint): string {
  return decimal(value, 2);
}

export function addMoney(...values: string[]): string {
  return money(values.reduce((sum, value) => sum + cents(value), 0n));
}

export function multiplyMoney(value: string, quantity: string): string {
  const product = cents(value) * scaled(quantity, 2);
  return money((product + 50n) / 100n);
}

export function percentMoney(value: string, rate: string): string {
  const product = cents(value) * scaled(rate, 2);
  return money((product + 5000n) / 10000n);
}

export function annualInterest(
  value: string,
  annualRate: string,
  days: number,
): string {
  const rateForDays =
    (scaled(annualRate, 2) * BigInt(Math.max(0, days))) / 365n;
  return money((cents(value) * rateForDays + 5000n) / 10000n);
}

export function vatFor(
  subtotal: string,
  treatment: "RC" | "VAT19" | "VAT0",
): { rate: string; amount: string; total: string } {
  const rate = treatment === "VAT19" ? "19.00" : "0.00";
  const amount = percentMoney(subtotal, rate);
  return { rate, amount, total: addMoney(subtotal, amount) };
}
