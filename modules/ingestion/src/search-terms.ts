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

export function areaSearchTerms(name: string, level: "state" | "district", year = new Date().getFullYear()): string[] {
  const area = name.trim();
  const suffix = level === "state" ? "Bundesland" : "Kreis";
  const values = new Set<string>();
  for (const publication of PUBLICATION_TERMS) {
    for (const variant of [publication, `${publication} PDF`, `${publication} ${year}`, `${publication} ${year - 1}`]) {
      values.add(`${variant} ${area} ${suffix}`);
    }
  }
  return [...values].slice(0, 72);
}
