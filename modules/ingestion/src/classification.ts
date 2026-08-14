export type ClassificationValueSource =
  | "filename"
  | "pdf-metadata"
  | "title-page"
  | "first-pages"
  | "manual";

export type DocumentClassification = {
  type: string | null;
  typeSource: ClassificationValueSource;
  typeConfidence: number | null;
  publicationName: string | null;
  publicationNameSource: ClassificationValueSource;
  publicationNameConfidence: number | null;
  editionLabel: string | null;
  editionSource: ClassificationValueSource;
  editionConfidence: number | null;
  periodStartYear: number | null;
  periodEndYear: number | null;
  periodIssue: number | null;
  periodSource: ClassificationValueSource;
  periodConfidence: number | null;
  regionPlace: string | null;
  regionDistrict: string | null;
  regionState: string | null;
  regionSource: ClassificationValueSource;
  regionConfidence: number | null;
  derivedAt: Date | null;
  correctedAt: Date | null;
  correctedBy: string | null;
};

export type DerivedClassification = Pick<
  DocumentClassification,
  | "type"
  | "typeConfidence"
  | "publicationName"
  | "publicationNameConfidence"
  | "editionLabel"
  | "editionConfidence"
  | "periodStartYear"
  | "periodEndYear"
  | "periodIssue"
  | "periodConfidence"
  | "regionPlace"
  | "regionDistrict"
  | "regionState"
  | "regionConfidence"
  | "typeSource"
  | "publicationNameSource"
  | "editionSource"
  | "periodSource"
  | "regionSource"
>;

const TYPE_RULES: Array<[string, RegExp, number]> = [
  ["kommunales-amtsblatt", /\bamtsblatt\b/i, 0.96],
  ["stadt-und-gemeindemagazin", /\b(stadt|gemeinde)(s)?magazin\b/i, 0.9],
  ["bürger-und-seniorenwegweiser", /\b(?:seniorenwegweiser|bürgerwegweiser|senioren.{0,20}wegweiser)\b/i, 0.97],
  ["branchenführer", /\bbranchenf(ü|u)hrer\b/i, 0.96],
  ["messekatalog", /\bmesse(katalog)?\b/i, 0.9],
];

function clean(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function firstMeaningfulLine(text: string): string | null {
  return text
    .split(/\r?\n/)
    .map((line) => clean(line))
    .find((line) => line.length >= 5 && !/^[\d\W]+$/.test(line)) ?? null;
}

function deriveRegion(text: string) {
  const normalized = clean(text);
  const district =
    /\bRhein-Neckar-Kreis\b/i.test(normalized) ? "Rhein-Neckar-Kreis" :
    /\bStädteRegion Aachen\b/i.test(normalized) ? "StädteRegion Aachen" :
    /\bWandsbek\b/i.test(normalized) ? "Wandsbek" :
    /\bHarburg\b/i.test(normalized) ? "Harburg" :
    null;
  const place = /\bOststeinbek\b/i.test(normalized) ? "Oststeinbek" : null;
  let state: string | null = null;
  if (/\bHamburg\b/i.test(normalized) || district === "Wandsbek" || district === "Harburg")
    state = "Hamburg";
  else if (district === "Rhein-Neckar-Kreis") state = "Baden-Württemberg";
  else if (/\bSchleswig-Holstein\b/i.test(normalized)) state = "Schleswig-Holstein";
  else if (/\bNordrhein-Westfalen\b|\bNRW\b/i.test(normalized) || district === "StädteRegion Aachen")
    state = "Nordrhein-Westfalen";
  return {
    place,
    district,
    state,
    confidence: district || place || state ? (place || district ? 0.9 : 0.65) : null,
  };
}

export function deriveDocumentClassification(input: {
  filename: string;
  pages: Array<{ pageNumber: number; text: string }>;
  pdfMetadata?: { title?: string; subject?: string; creationDate?: string };
}): DerivedClassification {
  const firstPages = input.pages
    .filter((page) => page.pageNumber <= 3)
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map((page) => page.text)
    .join("\n");
  const metadataText = [input.pdfMetadata?.title, input.pdfMetadata?.subject]
    .filter(Boolean).join("\n");
  const evidence = `${input.filename}\n${metadataText}\n${firstPages}`;
  const filenameTypeRule = TYPE_RULES.find(([, rule]) => rule.test(input.filename));
  const typeRule = filenameTypeRule ?? TYPE_RULES.find(([, rule]) => rule.test(`${metadataText}\n${firstPages}`));
  const title = clean(input.pdfMetadata?.title ?? "")
    || firstMeaningfulLine(firstPages)
    || clean(input.filename.replace(/\.pdf$/i, ""));
  const periodMatch = evidence.match(/\b(20\d{2})\s*[\/-]\s*(20\d{2})\b/);
  const yearMatch = evidence.match(/\b(20\d{2})\b/);
  const editionMatch = evidence.match(/\b(?:ausgabe|edition)\s*(?:Nr\.?\s*)?(\d{1,4})\b/i);
  const issueMatch = editionMatch && Number(editionMatch[1]) < 1000 ? editionMatch : null;
  const region = deriveRegion(evidence);
  return {
    type: typeRule?.[0] ?? null,
    typeConfidence: typeRule?.[2] ?? null,
    typeSource: filenameTypeRule ? "filename" : metadataText ? "pdf-metadata" : "title-page",
    publicationName: title,
    publicationNameConfidence: firstPages ? 0.72 : 0.35,
    publicationNameSource: input.pdfMetadata?.title ? "pdf-metadata" : firstPages ? "title-page" : "filename",
    editionLabel: periodMatch?.[0] ?? (editionMatch ? `Ausgabe ${editionMatch[1]}` : null),
    editionConfidence: periodMatch || editionMatch ? 0.82 : null,
    editionSource: metadataText ? "pdf-metadata" : "first-pages",
    periodStartYear: periodMatch ? Number(periodMatch[1]) : yearMatch ? Number(yearMatch[1]) : null,
    periodEndYear: periodMatch ? Number(periodMatch[2]) : yearMatch ? Number(yearMatch[1]) : null,
    periodIssue: issueMatch ? Number(issueMatch[1]) : null,
    periodConfidence: periodMatch ? 0.9 : yearMatch ? 0.7 : null,
    periodSource: metadataText && yearMatch && !firstPages.includes(yearMatch[0]) ? "pdf-metadata" : "first-pages",
    regionPlace: region.place,
    regionDistrict: region.district,
    regionState: region.state,
    regionConfidence: region.confidence,
    regionSource: "first-pages",
  };
}
