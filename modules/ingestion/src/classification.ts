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
].sort((left, right) => right.length - left.length);

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

function usableTitle(value: string): string | null {
  const title = clean(value);
  if (title.length < 5
    || /^(?:ausgabe|edition|jahrgang)\b/i.test(title)
    || /\bausgabe\b.*\bvom\b/i.test(title)
    || /^\d{1,2}\.\s*-\s*\d{1,2}\./.test(title)
    || /^(?:stand|gegründet|impressum|inhalt|content|messe|katalog)\b/i.test(title)
    || /\bfür\s+(?:liebhaber|entdecker)\b/i.test(title)) return null;
  return title;
}

function deriveRegion(text: string) {
  const normalized = clean(text);
  const state = STATES.find((item) => new RegExp(`\\b${item.replace(/-/g, "[- ]")}\\b`, "i").test(normalized)) ?? null;
  const districtMatch =
    normalized.match(/\bStädteRegion\s+([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:\s+[A-ZÄÖÜ][\wÄÖÜäöüß-]*){0,3})/)
    ?? normalized.match(/\b([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:-[A-ZÄÖÜ][\wÄÖÜäöüß-]*)*-Kreis)\b/i)
    ?? normalized.match(/\b(?:Landkreis|Kreis)\s+([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:\s+[A-ZÄÖÜ][\wÄÖÜäöüß-]*){0,3})/);
  const districtCandidate = districtMatch?.[1] ? clean(districtMatch[1]) : null;
  const districtPrefix = districtMatch?.[0]?.match(/^(StädteRegion|Landkreis|Kreis)\b/i)?.[1] ?? null;
  const district = districtCandidate && districtCandidate.length <= 100
    ? [districtPrefix, formatRegionName(districtCandidate)].filter(Boolean).join(" ")
    : null;
  const placePatterns = [
    /\b(?:Bezirksamt|Gemeinde|Stadt)\s+([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:\s+[A-ZÄÖÜ][\wÄÖÜäöüß-]*){0,2})/gi,
    /\bim\s+Bezirk\s+([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:\s+[A-ZÄÖÜ][\wÄÖÜäöüß-]*){0,2})/gi,
    /\bder\s+Stadt\s+([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:\s+[A-ZÄÖÜ][\wÄÖÜäöüß-]*){0,2})/gi,
    /\bwillkommen\s+in\s+([A-ZÄÖÜ][\wÄÖÜäöüß-]*)/gi,
  ];
  const placeCandidates = placePatterns.flatMap((pattern) => [...normalized.matchAll(pattern)]
    .map((match) => clean(match[1] ?? ""))
    .filter(Boolean)
    .filter((candidate) => !/^(?:zu|für|und|der|die|das|im|in|mit|von)\b/i.test(candidate))
    .map((candidate) => formatRegionName(candidate)));
  const placeCounts = new Map<string, number>();
  for (const candidate of placeCandidates) {
    placeCounts.set(candidate, (placeCounts.get(candidate) ?? 0) + 1);
  }
  const strongestPlace = [...placeCounts.entries()].sort((left, right) => right[1] - left[1])[0] ?? null;
  const districtName = district ? district.replace(/^(?:StädteRegion|Landkreis|Kreis)\s+/i, "") : null;
  const districtMentions = districtName
    ? (normalized.match(new RegExp(`\\b${districtName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi")) ?? []).length
    : 0;
  const place = strongestPlace
    && (!district || strongestPlace[1] >= 2 || districtMentions <= strongestPlace[1] * 4)
    ? strongestPlace[0]
    : null;
  return {
    place,
    district,
    state,
    confidence: state && (district || place) ? 0.9 : state ? 0.96 : district ? 0.72 : place ? (strongestPlace?.[1] && strongestPlace[1] > 1 ? 0.78 : 0.52) : null,
  };
}

export function deriveDocumentClassification(input: {
  filename: string;
  pages: Array<{
    pageNumber: number;
    text: string;
    titleCandidates?: Array<{ text: string; size: number }>;
  }>;
  pdfMetadata?: { title?: string; subject?: string; creationDate?: string };
}): DerivedClassification {
  const pages = input.pages
    .filter((page) => page.pageNumber <= 5)
    .sort((a, b) => a.pageNumber - b.pageNumber)
  const imprintPages = input.pages.filter((page) => page.pageNumber > 5 && /\bimpressum\b/i.test(page.text));
  const firstPage = pages.find((page) => page.pageNumber === 1)?.text ?? "";
  const firstPages = [...pages, ...imprintPages].map((page) => page.text).join("\n");
  const metadataText = [input.pdfMetadata?.title, input.pdfMetadata?.subject]
    .filter(Boolean).join("\n");
  const evidence = `${input.filename}\n${metadataText}\n${firstPages}`;
  const filenameTypeRule = TYPE_RULES.find(([, rule]) => rule.test(input.filename));
  const typeRule = filenameTypeRule ?? TYPE_RULES.find(([, rule]) => rule.test(`${metadataText}\n${firstPages}`));
  const metadataTitle = usableTitle(input.pdfMetadata?.title ?? "");
  const filenameTitle = /magazin/i.test(input.filename)
    ? usableTitle(input.filename.replace(/\.pdf$/i, "").replace(/[-_]+/g, " "))
    : null;
  const visualTitle = pages
    .sort((left, right) => left.pageNumber - right.pageNumber)
    .flatMap((page) => (page.titleCandidates ?? [])
      .slice()
      .sort((left, right) => right.size - left.size)
      .map((candidate) => usableTitle(candidate.text)))
      .find((candidate): candidate is string => Boolean(candidate));
  const textTitle = firstMeaningfulLine(firstPage);
  const titleDecision = [
    metadataTitle ? { value: metadataTitle, source: "pdf-metadata" as const, confidence: 0.92 } : null,
    filenameTitle ? { value: filenameTitle, source: "filename" as const, confidence: 0.68 } : null,
    visualTitle ? { value: visualTitle, source: "title-page" as const, confidence: 0.84 } : null,
    usableTitle(textTitle ?? "") ? { value: usableTitle(textTitle ?? "")!, source: "title-page" as const, confidence: 0.45 } : null,
    { value: clean(input.filename.replace(/\.pdf$/i, "")), source: "filename" as const, confidence: 0.35 },
  ].find((candidate) => Boolean(candidate?.value))!;
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
    publicationName: titleDecision.value,
    publicationNameConfidence: titleDecision.confidence,
    publicationNameSource: titleDecision.source,
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
