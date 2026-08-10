export type Currency = "EUR" | "GBP";

function scaled(value: string, digits: number): bigint {
  const normalized = value.trim().replace(",", ".");
  if (!/^[+-]?\d+(\.\d+)?$/.test(normalized)) {
    throw new Error("Ungültiger Dezimalbetrag");
  }
  const sign = normalized.startsWith("-") ? -1n : 1n;
  const unsigned = normalized.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > digits) {
    throw new Error(`Zu viele Nachkommastellen; maximal ${digits} erlaubt`);
  }
  const padded = (fraction + "0".repeat(digits)).slice(0, digits);
  return (
    sign *
    (BigInt(whole || "0") * 10n ** BigInt(digits) + BigInt(padded || "0"))
  );
}

function roundQuotient(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n) return -roundQuotient(-numerator, denominator);
  return (numerator + denominator / 2n) / denominator;
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
  return money(roundQuotient(product, 100n));
}

export function percentMoney(value: string, rate: string): string {
  const product = cents(value) * scaled(rate, 2);
  return money(roundQuotient(product, 10000n));
}

export function annualInterest(
  value: string,
  annualRate: string,
  days: number,
): string {
  const numerator =
    cents(value) * scaled(annualRate, 4) * BigInt(Math.max(0, days));
  return money(roundQuotient(numerator, 1000000n * 365n));
}

export function vatFor(
  subtotal: string,
  treatment: "RC" | "VAT19" | "VAT0",
): { rate: string; amount: string; total: string } {
  const rate = treatment === "VAT19" ? "19.00" : "0.00";
  const amount = percentMoney(subtotal, rate);
  return { rate, amount, total: addMoney(subtotal, amount) };
}
