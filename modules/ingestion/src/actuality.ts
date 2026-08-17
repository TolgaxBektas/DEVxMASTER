import type { DocumentClassification } from "./classification.js";

export const DEFAULT_ACTUALITY_MAX_AGE_YEARS = 3;

export type ActualityStatus = "current" | "outdated" | "unverified";

export function actualityMaxAgeYears(value = process.env.INGESTION_ACTUALITY_MAX_AGE_YEARS): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_ACTUALITY_MAX_AGE_YEARS;
}

export function documentActualityStatus(
  classification: Pick<DocumentClassification, "periodStartYear" | "periodEndYear"> | null,
  currentYear = new Date().getFullYear(),
  maxAgeYears = actualityMaxAgeYears(),
): ActualityStatus {
  const endYear = classification?.periodEndYear;
  if (endYear == null || endYear <= 0) return "unverified";
  return endYear >= currentYear - maxAgeYears ? "current" : "outdated";
}

export function sourceActualityHint(
  metadata: Record<string, unknown> | null,
  currentYear = new Date().getFullYear(),
  maxAgeYears = actualityMaxAgeYears(),
): ActualityStatus | null {
  if (!metadata) return null;
  const text = Object.values(metadata).filter((value): value is string => typeof value === "string").join(" ");
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
  if (!years.length) return null;
  return documentActualityStatus({ periodEndYear: Math.max(...years), periodStartYear: Math.min(...years) }, currentYear, maxAgeYears);
}
