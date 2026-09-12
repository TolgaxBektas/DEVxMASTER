const evidenceLabels: Record<string, string> = {
  geometry: "Materielle Fläche",
  logo: "Logo/Signet",
  contact: "Telefonkontakt",
  "page-dominant": "Ganzseitige Fläche",
  "publisher-marking": "Verlagsvermerk „Anzeige“",
  "provenance-uncertain": "Herkunft unklar",
  advertiser: "Werbetreibender",
  typography: "Typografische Gestaltung",
  whitespace: "Freiraum um die Anzeige",
  "positiv:p1a": "P1a Rechtsform",
  "positiv:p1b": "P1b Branchenwort",
  "positiv:p1c": "P1c hervorgehobener Absender",
  "positiv:p2": "P2 Werbeabsicht",
  "positiv:p3": "P3 Kontaktweg",
  "positiv:p4": "P4 Gestaltung",
};

export function evidenceLabel(value: string): string {
  return evidenceLabels[value] ?? "Zusätzlicher Prüfbeleg";
}
