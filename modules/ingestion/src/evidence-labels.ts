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
};

export function evidenceLabel(value: string): string {
  return evidenceLabels[value] ?? "Zusätzlicher Prüfbeleg";
}
