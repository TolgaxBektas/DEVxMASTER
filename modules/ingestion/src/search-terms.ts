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

export function areaSearchTerms(
  name: string,
  _level: "state" | "district",
  year = new Date().getFullYear(),
  kind?: string,
): string[] {
  const area = name.trim();
  const type = kind?.trim() && !["Kreisfreie Stadt", "Stadtkreis"].includes(kind.trim())
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
  return [...values].slice(0, 24);
}
