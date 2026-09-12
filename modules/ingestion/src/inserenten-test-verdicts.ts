export type InserentenTestVerdict = {
  occurrenceId: number;
  verdict: string;
  reason: string;
};

function parseTsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === "\"") {
        if (content[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === "\"" && field.length === 0) {
      quoted = true;
    } else if (character === "\t") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
      if (character === "\r" && content[index + 1] === "\n") index += 1;
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("Urteildatei enthält ein nicht geschlossenes CSV-Feld");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  return rows;
}

export function parseVerdictFile(content: string): InserentenTestVerdict[] {
  const rows = parseTsv(content);
  const header = rows.shift();
  if (!header) throw new Error("Urteildatei ist leer");
  const columns = new Map(header.map((value, index) => [value.trim(), index]));
  const required = ["occurrence_id", "urteil_neu", "grund"];
  const missing = required.filter((name) => !columns.has(name));
  if (missing.length) {
    throw new Error(`Urteildatei enthält erforderliche Spalten nicht: ${missing.join(", ")}`);
  }
  const valueAt = (row: string[], name: string) => row[columns.get(name)!] ?? "";
  return rows.map((row, index) => {
    const occurrenceId = Number(valueAt(row, "occurrence_id"));
    const verdict = valueAt(row, "urteil_neu").trim();
    if (!Number.isInteger(occurrenceId) || occurrenceId <= 0) {
      throw new Error(`Ungültige Fundstellen-ID in Urteildateile, Zeile ${index + 2}`);
    }
    if (!verdict) {
      throw new Error(`Leeres Urteil in Urteildatei, Zeile ${index + 2}`);
    }
    return {
      occurrenceId,
      verdict,
      reason: valueAt(row, "grund").trim(),
    };
  });
}

export function collapseVerdicts(rows: InserentenTestVerdict[]): InserentenTestVerdict[] {
  const collapsed = new Map<number, InserentenTestVerdict>();
  for (const row of rows) {
    const previous = collapsed.get(row.occurrenceId);
    if (previous && previous.verdict !== row.verdict) {
      throw new Error(`Widersprüchliche Urteile für Fundstelle ${row.occurrenceId}`);
    }
    if (!previous) collapsed.set(row.occurrenceId, row);
  }
  return [...collapsed.values()];
}

export function rejectionEvidence(reason: string): string[] {
  const evidence = reason
    .split(",")
    .map((token) => token.trim())
    .filter((token) =>
      token.startsWith("veto:")
      || token.startsWith("fehlend:")
      || token.startsWith("unclear:"),
    );
  return evidence.length ? [...new Set(evidence)] : ["veto:falscher-ausschnitt"];
}

export function mergeEvidence(existing: string[] | null, added: string[]): string[] {
  return [...new Set([...(existing ?? []), ...added])];
}

export function plannedRejection(current: { status: string }, verdict: string): boolean {
  return verdict === "keine_anzeige" && current.status === "detected";
}
