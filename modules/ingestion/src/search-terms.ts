export const PUBLICATION_TERMS = [
  "Seniorenwegweiser",
  "Bürgerinformation",
  "Bürgerbroschüre",
  "Gesundheitsführer",
  "Branchenführer",
  "Gastgeberverzeichnis",
  "Vereinsmagazin",
  "Festschrift",
  "Stadtmagazin",
] as const;

export const INTENSIVE_PUBLICATION_TERMS = [
  "Bürgerinformationsbroschüre", "Informationsbroschüre", "Infobroschüre", "Bürgerinfo",
  "Bürgerhandbuch", "Gemeindebroschüre", "Stadtbroschüre", "Neubürgerbroschüre",
  "Standortbroschüre", "Wirtschaftsbroschüre", "Einkaufsführer", "Branchenverzeichnis",
  "Gewerbeverzeichnis", "Gästeführer", "Gästejournal", "Urlaubsmagazin", "Freizeitführer",
  "Ortsplan", "Seniorenkompass", "Seniorenratgeber", "Pflegeratgeber", "Familienratgeber",
  "Familienwegweiser", "Familienbroschüre", "Hochzeitsmagazin", "Amtsblatt",
  "Mitteilungsblatt", "Gemeindeblatt", "Gemeindemagazin",
] as const;

export const PUBLISHER_PHRASES = [
  "mit freundlicher Unterstützung der Inserenten",
  "Gesamtherstellung und Anzeigenverwaltung",
  "Anzeigenverwaltung Broschüre",
  "mediaprint total-lokal",
  "inixmedia",
  "WEKA info verlag",
] as const;

export function areaSearchTerms(
  name: string,
  level: "state" | "district",
  year = new Date().getFullYear(),
  kind?: string,
  options?: { intensive?: boolean },
): string[] {
  const area = name.trim();
  const type = level === "district" && kind?.trim() && !["Kreisfreie Stadt", "Stadtkreis"].includes(kind.trim())
    ? `${kind.trim()} `
    : "";
  const values = new Set<string>();
  for (const publication of PUBLICATION_TERMS) {
    values.add(`${publication} ${type}${area}`.trim());
    values.add(`${publication} PDF ${type}${area}`.trim());
  }
  for (const publication of PUBLICATION_TERMS.slice(0, 3)) {
    values.add(`${publication} ${year} ${type}${area}`.trim());
  }
  if (options?.intensive) {
    for (const publication of INTENSIVE_PUBLICATION_TERMS) {
      values.add(`${publication} ${type}${area}`.trim());
      values.add(`${publication} PDF ${type}${area}`.trim());
    }
    for (const phrase of PUBLISHER_PHRASES) {
      values.add(`${phrase} ${area}`.trim());
    }
  }
  return [...values].slice(0, options?.intensive ? 96 : 24);
}
