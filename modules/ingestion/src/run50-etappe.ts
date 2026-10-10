import { createHash } from "node:crypto";

export type Run50EtappeArguments = {
  tenantId: number;
  etappe: string;
  anteil: number;
  apply: boolean;
};

export type Run50EtappeCandidate = {
  documentId: number;
  ags: string;
  areaName: string;
  pages: number;
  filename: string;
  sha256: string;
};

export function parseRun50EtappeArguments(args: string[]): Run50EtappeArguments {
  let tenantValue: string | undefined;
  let etappe: string | undefined;
  let anteilValue: string | undefined;
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
    if (!["--mandant", "--etappe", "--anteil"].includes(argument ?? "")) {
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
    } else {
      if (anteilValue !== undefined) {
        throw new Error("--anteil darf nur einmal angegeben werden.");
      }
      anteilValue = value;
    }
  }

  if (tenantValue === undefined) throw new Error("Pflichtargument --mandant <id> fehlt.");
  if (etappe === undefined || !etappe.trim()) {
    throw new Error("Pflichtargument --etappe <name> fehlt.");
  }
  if (anteilValue === undefined) {
    throw new Error("Pflichtargument --anteil <prozent> fehlt.");
  }

  const tenantId = Number(tenantValue);
  if (!/^\d+$/.test(tenantValue) || !Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw new Error("Die Mandantenkennung muss eine positive Ganzzahl sein.");
  }
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(anteilValue)) {
    throw new Error("Der Anteil muss eine Zahl größer 0 und höchstens 100 sein.");
  }
  const anteil = Number(anteilValue);
  if (!Number.isFinite(anteil) || anteil <= 0 || anteil > 100) {
    throw new Error("Der Anteil muss eine Zahl größer 0 und höchstens 100 sein.");
  }

  return { tenantId, etappe, anteil, apply };
}

export function run50EtappeTargetPages(totalProcessedPages: number, anteil: number): number {
  return Math.ceil(totalProcessedPages * anteil / 100);
}

export function selectRun50EtappeDocuments(
  candidates: Run50EtappeCandidate[],
  targetPages: number,
  etappe: string,
): Run50EtappeCandidate[] {
  if (targetPages <= 0) return [];
  const orderedCandidates = candidates.map((candidate) => ({
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
