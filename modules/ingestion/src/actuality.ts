import type { DocumentClassification } from "./classification.js";

export const DEFAULT_ACTUALITY_MAX_AGE_YEARS = 2.5;

export type ActualityStatus = "current" | "outdated" | "unverified";

export function actualityMaxAgeYears(value = process.env.INGESTION_ACTUALITY_MAX_AGE_YEARS): number {
  if (value === undefined || value.trim() === "") return DEFAULT_ACTUALITY_MAX_AGE_YEARS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_ACTUALITY_MAX_AGE_YEARS;
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
  const text = Object.values(metadata)
    .filter((value): value is string => typeof value === "string")
    .map((value) => {
      try {
        return decodeURIComponent(value);
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
        return value.replace(/%20/gi, " ");
      }
    })
    .join(" ");
  const years = [...text.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)].map((match) => Number(match[1]));
  if (!years.length) return null;
  return documentActualityStatus({ periodEndYear: Math.max(...years), periodStartYear: Math.min(...years) }, currentYear, maxAgeYears);
}
