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
  ["kommunales-amtsblatt", /\bamtsblatt\b/i, 0.94],
  ["stadt-und-gemeindemagazin", /(?:\b(?:stadt|gemeinde)[- ]?magazin\b|[A-Za-zÄÖÜäöüß-]{3,}[- ]magazin\b)/i, 0.86],
  ["bürger-und-seniorenwegweiser", /\b(?:seniorenwegweiser|bürgerwegweiser|wegweiser\s+für\s+(?:senior|bürger)|senioren.{0,20}wegweiser)\b/i, 0.95],
  ["branchenführer", /\bbranchenf(ü|u)hrer\b/i, 0.95],
  ["messekatalog", /messe[- ]?(?:katalog|führer)/i, 0.9],
];

const STATES = [
  "Baden-Württemberg", "Bayern", "Berlin", "Brandenburg", "Bremen",
  "Hamburg", "Hessen", "Mecklenburg-Vorpommern", "Niedersachsen",
  "Nordrhein-Westfalen", "Rheinland-Pfalz", "Saarland", "Sachsen",
  "Sachsen-Anhalt", "Schleswig-Holstein", "Thüringen",
];

function clean(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function formatRegionName(value: string): string {
  const formatted = value
    .toLocaleLowerCase("de-DE")
    .split(/([ -])/)
    .map((part) => /^[a-zäöüß]/i.test(part) ? part.charAt(0).toLocaleUpperCase("de-DE") + part.slice(1) : part)
    .join("");
  return formatted.replace(/^Städteregion\b/i, "StädteRegion");
}

function firstMeaningfulLine(text: string): string | null {
  return text
    .split(/\r?\n/)
    .map((line) => clean(line))
    .find((line) => line.length >= 5 && !/^[\d\W]+$/.test(line)) ?? null;
}

function deriveRegion(text: string) {
  const normalized = clean(text);
  const state = STATES.find((item) => new RegExp(`\\b${item.replace("-", "[- ]")}\\b`, "i").test(normalized)) ?? null;
  const districtMatch =
    normalized.match(/\bStädteRegion\s+([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:\s+[A-ZÄÖÜ][\wÄÖÜäöüß-]*){0,3})/i)
    ?? normalized.match(/\b([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:-[A-ZÄÖÜ][\wÄÖÜäöüß-]*)*-Kreis)\b/i)
    ?? normalized.match(/\b(?:Landkreis|Kreis)\s+([A-ZÄÖÜ][^\n,.;|]+)/i);
  const district = districtMatch
    ? formatRegionName(clean(districtMatch[0]).replace(/\s+\d+$/, ""))
    : null;
  const placeMatch =
    normalized.match(/\b(?:Bezirksamt|Gemeinde|Stadt)\s+([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:\s+[A-ZÄÖÜ][\wÄÖÜäöüß-]*){0,2})/i)
    ?? normalized.match(/\bim\s+Bezirk\s+([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:\s+[A-ZÄÖÜ][\wÄÖÜäöüß-]*){0,2})/i)
    ?? normalized.match(/\bder\s+Stadt\s+([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:\s+[A-ZÄÖÜ][\wÄÖÜäöüß-]*){0,2})/i);
  const place = placeMatch?.[1] ? formatRegionName(clean(placeMatch[1])) : null;
  return {
    place,
    district,
    state,
    confidence: state && (district || place) ? 0.9 : state ? 0.96 : district ? 0.72 : place ? 0.62 : null,
  };
}

export function deriveDocumentClassification(input: {
  filename: string;
  pages: Array<{ pageNumber: number; text: string }>;
  pdfMetadata?: { title?: string; subject?: string; creationDate?: string };
}): DerivedClassification {
  const pages = input.pages
    .filter((page) => page.pageNumber <= 3)
    .sort((a, b) => a.pageNumber - b.pageNumber)
  const firstPage = pages.find((page) => page.pageNumber === 1)?.text ?? "";
  const firstPages = pages.map((page) => page.text).join("\n");
  const metadataText = [input.pdfMetadata?.title, input.pdfMetadata?.subject]
    .filter(Boolean).join("\n");
  const evidence = `${input.filename}\n${metadataText}\n${firstPages}`;
  const filenameTypeRule = TYPE_RULES.find(([, rule]) => rule.test(input.filename));
  const typeRule = filenameTypeRule ?? TYPE_RULES.find(([, rule]) => rule.test(`${metadataText}\n${firstPages}`));
  const title = clean(input.pdfMetadata?.title ?? "")
    || firstMeaningfulLine(firstPages)
    || clean(input.filename.replace(/\.pdf$/i, ""));
  const contextualLines = firstPages
    .split(/\r?\n/)
    .filter((line) => /\b(?:ausgabe|edition|jahrgang)\b/i.test(line)
      || /\b\d{1,2}\.\s*-\s*\d{1,2}\.\s+\p{L}+\s+20\d{2}\b/u.test(line))
    .join("\n");
  const periodEvidence = `${input.filename}\n${metadataText}\n${contextualLines}`;
  const periodMatch = periodEvidence.match(/\b(20\d{2})\s*[\/-]\s*(20\d{2})\b/);
  const editionWithYear = periodEvidence.match(/\b(?:ausgabe|edition)\s*(?:Nr\.?\s*)?(\d{1,3})\s*[\/-]\s*(20\d{2})\b/i);
  const editionMatch = periodEvidence.match(/\b(?:ausgabe|edition)\s*(?:Nr\.?\s*)?(\d{1,4})\b/i);
  const contextualYear = periodEvidence.match(/\b(?:ausgabe|edition|jahrgang)\s*(?:Nr\.?\s*)?(20\d{2})\b/i);
  const dateYear = periodEvidence.match(/\b\d{1,2}\.\s*-\s*\d{1,2}\.\s+\p{L}+\s+(20\d{2})\b/u);
  const yearMatch = editionWithYear ? editionWithYear : contextualYear ?? dateYear ?? periodEvidence.match(/\b(20\d{2})\b/);
  const issueMatch = editionMatch && Number(editionMatch[1]) < 1000 ? editionMatch : null;
  const region = deriveRegion(evidence);
  return {
    type: typeRule?.[0] ?? null,
    typeConfidence: typeRule?.[2] ?? null,
    typeSource: filenameTypeRule ? "filename" : metadataText ? "pdf-metadata" : "title-page",
    publicationName: title,
    publicationNameConfidence: firstPages ? 0.72 : 0.35,
    publicationNameSource: input.pdfMetadata?.title ? "pdf-metadata" : firstPages ? "title-page" : "filename",
    editionLabel: editionWithYear ? `Ausgabe ${editionWithYear[1]}/${editionWithYear[2]}` : periodMatch?.[0] ?? (editionMatch ? `Ausgabe ${editionMatch[1]}` : null),
    editionConfidence: editionWithYear || periodMatch ? 0.86 : editionMatch ? 0.7 : null,
    editionSource: metadataText ? "pdf-metadata" : "first-pages",
    periodStartYear: periodMatch ? Number(periodMatch[1]) : editionWithYear ? Number(editionWithYear[2]) : yearMatch ? Number(yearMatch[1]) : null,
    periodEndYear: periodMatch ? Number(periodMatch[2]) : editionWithYear ? Number(editionWithYear[2]) : yearMatch ? Number(yearMatch[1]) : null,
    periodIssue: editionWithYear ? Number(editionWithYear[1]) : issueMatch ? Number(issueMatch[1]) : null,
    periodConfidence: periodMatch || editionWithYear ? 0.86 : contextualYear || dateYear ? 0.75 : yearMatch ? 0.45 : null,
    periodSource: metadataText && yearMatch && !firstPages.includes(yearMatch[0]) ? "pdf-metadata" : "first-pages",
    regionPlace: region.place,
    regionDistrict: region.district,
    regionState: region.state,
    regionConfidence: region.confidence,
    regionSource: "first-pages",
  };
}
