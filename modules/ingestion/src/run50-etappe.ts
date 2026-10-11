import { createHash } from "node:crypto";
import { actualityMaxAgeYears } from "./actuality.js";

export type Run50EtappeArguments = {
  tenantId: number;
  etappe: string;
  anteil?: number;
  apply: boolean;
  maxPages?: number;
  exclusionFile?: string;
  documentFile?: string;
};

export type Run50EtappeCandidate = {
  documentId: number;
  ags: string | null;
  areaName: string | null;
  areaLabel: string;
  areaOrigin: "quelle" | "anzeigen" | "offen";
  periodEndYear: number | null;
  pages: number;
  filename: string;
  sha256: string;
};

export function isRun50EtappeYearEligible(
  periodEndYear: number | null,
  currentYear = new Date().getFullYear(),
  maxAgeYears = actualityMaxAgeYears(),
): boolean {
  return periodEndYear !== null
    && periodEndYear >= currentYear - maxAgeYears
    && periodEndYear <= currentYear;
}

export type Run50EtappeContact = {
  city: string | null;
  postalCode: string | null;
};

function normalizeRun50EtappeCity(city: string | null): string | null {
  const normalized = city?.trim().replace(/\s+/g, " ") ?? "";
  return normalized || null;
}

export function deriveRun50EtappeAreaFromContacts(
  contacts: Run50EtappeContact[],
): { city: string; postalCode: string | null; votes: number; total: number } | null {
  const cityVotes = new Map<string, number>();
  const normalizedContacts = contacts.flatMap((contact) => {
    const city = normalizeRun50EtappeCity(contact.city);
    return city ? [{ city, postalCode: contact.postalCode?.trim() ?? "" }] : [];
  });
  for (const { city } of normalizedContacts) {
    cityVotes.set(city, (cityVotes.get(city) ?? 0) + 1);
  }

  const [city, votes] = [...cityVotes.entries()].sort((left, right) =>
    right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
  )[0] ?? [];
  if (city === undefined || votes === undefined) return null;

  const postalCodeVotes = new Map<string, number>();
  for (const contact of normalizedContacts) {
    if (contact.city !== city || !/^\d{5}$/.test(contact.postalCode)) continue;
    postalCodeVotes.set(
      contact.postalCode,
      (postalCodeVotes.get(contact.postalCode) ?? 0) + 1,
    );
  }
  const [postalCode] = [...postalCodeVotes.entries()].sort((left, right) =>
    right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
  )[0] ?? [];

  return {
    city,
    postalCode: postalCode ?? null,
    votes,
    total: normalizedContacts.length,
  };
}

export function parseRun50EtappeExclusionList(text: string): Set<number> {
  const documentIds = new Set<number>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(\d+)(?=\s|#|$)/.exec(trimmed);
    const documentId = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(documentId) || documentId <= 0) {
      throw new Error(`Ungültige Dokument-ID in Zeile ${index + 1}.`);
    }
    documentIds.add(documentId);
  }
  return documentIds;
}

export function parseRun50EtappeDocumentList(text: string): number[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headerIndex < 0) return [];

  const header = lines[headerIndex]!.split("\t").map((column) => column.trim());
  const documentIdColumn = header.indexOf("document_id");
  const isTsv = documentIdColumn >= 0;
  const firstDataLine = isTsv ? headerIndex + 1 : 0;
  const documentIds = new Set<number>();

  for (let index = firstDataLine; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    const value = isTsv
      ? line.split("\t")[documentIdColumn]?.trim() ?? ""
      : line.trim();
    const documentId = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(documentId) || documentId <= 0) {
      throw new Error(`Ungültige Dokument-ID in Zeile ${index + 1}.`);
    }
    documentIds.add(documentId);
  }

  return [...documentIds];
}

export function parseRun50EtappeArguments(args: string[]): Run50EtappeArguments {
  let tenantValue: string | undefined;
  let etappe: string | undefined;
  let anteilValue: string | undefined;
  let maxPagesValue: string | undefined;
  let exclusionFile: string | undefined;
  let documentFile: string | undefined;
  let apply = false;
  let applySeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--anwenden") {
      if (applySeen) throw new Error("--anwenden darf nur einmal angegeben werden.");
      apply = true;
      applySeen = true;
      continue;
    }
    if (![
      "--mandant",
      "--etappe",
      "--anteil",
      "--max-seiten",
      "--ausschliessen",
      "--dokumente",
    ].includes(argument ?? "")) {
      throw new Error(`Unbekanntes Argument: ${argument}`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Pflichtargument ${argument} <wert> fehlt.`);
    }
    index += 1;

    if (argument === "--mandant") {
      if (tenantValue !== undefined) {
        throw new Error("--mandant darf nur einmal angegeben werden.");
      }
      tenantValue = value;
    } else if (argument === "--etappe") {
      if (etappe !== undefined) {
        throw new Error("--etappe darf nur einmal angegeben werden.");
      }
      etappe = value;
    } else if (argument === "--anteil") {
      if (anteilValue !== undefined) {
        throw new Error("--anteil darf nur einmal angegeben werden.");
      }
      anteilValue = value;
    } else if (argument === "--max-seiten") {
      if (maxPagesValue !== undefined) {
        throw new Error("--max-seiten darf nur einmal angegeben werden.");
      }
      maxPagesValue = value;
    } else if (argument === "--ausschliessen") {
      if (exclusionFile !== undefined) {
        throw new Error("--ausschliessen darf nur einmal angegeben werden.");
      }
      exclusionFile = value;
    } else {
      if (documentFile !== undefined) {
        throw new Error("--dokumente darf nur einmal angegeben werden.");
      }
      documentFile = value;
    }
  }

  if (tenantValue === undefined) throw new Error("Pflichtargument --mandant <id> fehlt.");
  if (etappe === undefined || !etappe.trim()) {
    throw new Error("Pflichtargument --etappe <name> fehlt.");
  }
  if (anteilValue !== undefined && documentFile !== undefined) {
    throw new Error("--anteil und --dokumente schließen sich gegenseitig aus.");
  }
  if (anteilValue === undefined && documentFile === undefined) {
    throw new Error("Pflichtargument --anteil <prozent> oder --dokumente <datei> fehlt.");
  }

  const tenantId = Number(tenantValue);
  if (!/^\d+$/.test(tenantValue) || !Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw new Error("Die Mandantenkennung muss eine positive Ganzzahl sein.");
  }
  let anteil: number | undefined;
  if (anteilValue !== undefined) {
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(anteilValue)) {
      throw new Error("Der Anteil muss eine Zahl größer 0 und höchstens 100 sein.");
    }
    anteil = Number(anteilValue);
    if (!Number.isFinite(anteil) || anteil <= 0 || anteil > 100) {
      throw new Error("Der Anteil muss eine Zahl größer 0 und höchstens 100 sein.");
    }
  }

  let maxPages: number | undefined;
  if (maxPagesValue !== undefined) {
    maxPages = Number(maxPagesValue);
    if (!/^\d+$/.test(maxPagesValue) || !Number.isSafeInteger(maxPages) || maxPages <= 0) {
      throw new Error("Die maximale Seitenzahl muss eine positive Ganzzahl sein.");
    }
  }

  return {
    tenantId,
    etappe,
    apply,
    ...(anteil === undefined ? {} : { anteil }),
    ...(maxPages === undefined ? {} : { maxPages }),
    ...(exclusionFile === undefined ? {} : { exclusionFile }),
    ...(documentFile === undefined ? {} : { documentFile }),
  };
}

export function run50EtappeTargetPages(totalProcessedPages: number, anteil: number): number {
  return Math.ceil(totalProcessedPages * anteil / 100);
}

export function selectRun50EtappeDocuments(
  candidates: Run50EtappeCandidate[],
  targetPages: number,
  etappe: string,
  maxPages?: number,
  currentYear = new Date().getFullYear(),
  maxAgeYears = actualityMaxAgeYears(),
): Run50EtappeCandidate[] {
  if (targetPages <= 0) return [];
  const eligibleCandidates = candidates.filter((candidate) =>
    isRun50EtappeYearEligible(candidate.periodEndYear, currentYear, maxAgeYears)
      && (maxPages === undefined || candidate.pages <= maxPages)
  );
  const orderedCandidates = eligibleCandidates.map((candidate) => ({
    candidate,
    order: createHash("sha256")
      .update(`${etappe}:${candidate.sha256}`)
      .digest("hex"),
  })).sort((left, right) =>
    left.order < right.order ? -1
      : left.order > right.order ? 1
        : left.candidate.documentId - right.candidate.documentId,
  );
  const selected: Run50EtappeCandidate[] = [];
  let selectedPages = 0;
  for (const { candidate } of orderedCandidates) {
    selected.push(candidate);
    selectedPages += candidate.pages;
    if (selectedPages >= targetPages) return selected;
  }
  return selected;
}
