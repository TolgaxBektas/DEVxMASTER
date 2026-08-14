export type ClassificationValueSource =
  | "filename"
  | "pdf-metadata"
  | "title-page"
  | "first-pages"
  | "manual";

export type DocumentClassification = {
  type: string | null;
  typeSource: ClassificationValueSource | null;
  typeConfidence: number | null;
  publicationName: string | null;
  publicationNameSource: ClassificationValueSource | null;
  publicationNameConfidence: number | null;
  editionLabel: string | null;
  editionSource: ClassificationValueSource | null;
  editionConfidence: number | null;
  periodStartYear: number | null;
  periodEndYear: number | null;
  periodIssue: number | null;
  periodSource: ClassificationValueSource | null;
  periodConfidence: number | null;
  regionPlace: string | null;
  regionDistrict: string | null;
  regionState: string | null;
  regionSource: ClassificationValueSource | null;
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
  const connectors = new Set(["am", "an", "auf", "bei", "der", "die", "das", "im", "in", "ob", "oder", "von", "zu", "zum", "zur"]);
  let wordIndex = 0;
  const formatted = value
    .toLocaleLowerCase("de-DE")
    .split(/([ -])/)
    .map((part) => {
      if (!/^[a-zäöüß]/i.test(part)) return part;
      const formattedPart = wordIndex > 0 && connectors.has(part)
        ? part
        : part.charAt(0).toLocaleUpperCase("de-DE") + part.slice(1);
      wordIndex += 1;
      return formattedPart;
    })
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

function plausibleRegionName(value: string, maximumLength: number): boolean {
  const candidate = clean(value);
  const words = candidate.split(/\s+/);
  const firstWord = words[0]?.replace(/-/g, "") ?? "";
  const lastWord = words.at(-1)?.replace(/-/g, "") ?? "";
  return candidate.length >= 3
    && candidate.length <= maximumLength
    && firstWord.length >= 3
    && lastWord.length >= 3
    && /[A-Za-zÄÖÜäöüß]{3}/.test(candidate);
}

type PeriodDecision = {
  editionLabel: string | null;
  editionConfidence: number | null;
  periodStartYear: number;
  periodEndYear: number;
  periodIssue: number | null;
  periodConfidence: number;
  source: "filename" | "pdf-metadata" | "title-page" | "first-pages";
};

function derivePeriodCandidate(
  text: string,
  source: PeriodDecision["source"],
  allowBareYear: boolean,
): PeriodDecision | null {
  const periodMatch = text.match(/\b(20\d{2})\s*[\/-]\s*(20\d{2})\b/);
  if (periodMatch) {
    return {
      editionLabel: periodMatch[0],
      editionConfidence: 0.86,
      periodStartYear: Number(periodMatch[1]),
      periodEndYear: Number(periodMatch[2]),
      periodIssue: null,
      periodConfidence: 0.86,
      source,
    };
  }
  const editionWithYear = text.match(/\b(?:ausgabe|edition)\s*(?:Nr\.?\s*)?(\d{1,3})\s*[\/-]\s*(20\d{2})\b/i);
  if (editionWithYear) {
    return {
      editionLabel: `Ausgabe ${editionWithYear[1]}/${editionWithYear[2]}`,
      editionConfidence: 0.86,
      periodStartYear: Number(editionWithYear[2]),
      periodEndYear: Number(editionWithYear[2]),
      periodIssue: Number(editionWithYear[1]),
      periodConfidence: 0.86,
      source,
    };
  }
  const editionMatch = text.match(/\b(?:ausgabe|edition)\s*(?:Nr\.?\s*)?(\d{1,4})\b/i);
  if (editionMatch && Number(editionMatch[1]) < 1000) {
    return {
      editionLabel: `Ausgabe ${editionMatch[1]}`,
      editionConfidence: 0.7,
      periodStartYear: 0,
      periodEndYear: 0,
      periodIssue: Number(editionMatch[1]),
      periodConfidence: 0,
      source,
    };
  }
  const contextualYear = text.match(/\b(?:ausgabe|edition|jahrgang)\s*(?:Nr\.?\s*)?(20\d{2})\b/i);
  if (contextualYear) {
    return {
      editionLabel: `Ausgabe ${contextualYear[1]}`,
      editionConfidence: 0.75,
      periodStartYear: Number(contextualYear[1]),
      periodEndYear: Number(contextualYear[1]),
      periodIssue: null,
      periodConfidence: 0.75,
      source,
    };
  }
  const dateYear = text.match(/\b\d{1,2}\.\s*-\s*\d{1,2}\.\s+\p{L}+\s+(20\d{2})\b/u);
  if (dateYear) {
    return {
      editionLabel: null,
      editionConfidence: null,
      periodStartYear: Number(dateYear[1]),
      periodEndYear: Number(dateYear[1]),
      periodIssue: null,
      periodConfidence: 0.75,
      source,
    };
  }
  const bareYear = allowBareYear ? text.match(/\b(20\d{2})\b/) : null;
  return bareYear ? {
    editionLabel: null,
    editionConfidence: null,
    periodStartYear: Number(bareYear[1]),
    periodEndYear: Number(bareYear[1]),
    periodIssue: null,
    periodConfidence: 0.45,
    source,
  } : null;
}

function deriveRegion(text: string) {
  const normalized = clean(text);
  const state = STATES.find((item) => new RegExp(`\\b${item.replace(/-/g, "[- ]")}\\b`, "i").test(normalized)) ?? null;
  const districtMatch =
    normalized.match(/\bStädteRegion\s+([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:\s+(?:[A-ZÄÖÜ][\wÄÖÜäöüß-]*|[a-zäöüß]{2,3})){0,3})/)
    ?? normalized.match(/\b([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:-[A-ZÄÖÜ][\wÄÖÜäöüß-]*)*-Kreis)\b/i)
    ?? normalized.match(/\b(?:Landkreis|Kreis)\s+([A-ZÄÖÜ][\wÄÖÜäöüß-]*(?:\s+(?:[A-ZÄÖÜ][\wÄÖÜäöüß-]*|[a-zäöüß]{2,3})){0,3})/);
  const districtCandidate = districtMatch?.[1] ? clean(districtMatch[1]) : null;
  const districtPrefix = districtMatch?.[0]?.match(/^(StädteRegion|Landkreis|Kreis)\b/i)?.[1] ?? null;
  const district = districtCandidate && plausibleRegionName(districtCandidate, 100)
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
    .filter((candidate) => plausibleRegionName(candidate, 100))
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
  const placeConfidence = strongestPlace?.[1] && strongestPlace[1] > 1 ? 0.78 : 0.52;
  return {
    place,
    district,
    state,
    confidence: state && district
      ? 0.9
      : state && place
        ? (placeConfidence > 0.7 ? 0.82 : 0.65)
        : state
          ? 0.96
          : district
            ? 0.72
            : place
              ? placeConfidence
              : null,
  };
}

export function selectRegionSource(
  region: ReturnType<typeof deriveRegion>,
  candidates: Array<{
    source: ClassificationValueSource;
    value: ReturnType<typeof deriveRegion>;
  }>,
): ClassificationValueSource | null {
  const selectedFields = [region.place, region.district, region.state].filter(Boolean);
  const bestCandidate = candidates
    .map((candidate) => ({
      ...candidate,
      matches: [region.place, region.district, region.state]
        .filter((field) => field && [candidate.value.place, candidate.value.district, candidate.value.state].includes(field))
        .length,
    }))
    .sort((left, right) => right.matches - left.matches)[0];
  return selectedFields.length > 0 && (bestCandidate?.matches ?? 0) > 0
    ? bestCandidate!.source
    : null;
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
  const metadataTypeRule = TYPE_RULES.find(([, rule]) => rule.test(metadataText));
  const titlePageTypeRule = TYPE_RULES.find(([, rule]) => rule.test(firstPage));
  const firstPagesTypeRule = TYPE_RULES.find(([, rule]) =>
    rule.test([...pages.slice(1), ...imprintPages].map((page) => page.text).join("\n")));
  const typeDecision = filenameTypeRule
    ? { value: filenameTypeRule[0], confidence: filenameTypeRule[2], source: "filename" as const }
    : metadataTypeRule
      ? { value: metadataTypeRule[0], confidence: metadataTypeRule[2], source: "pdf-metadata" as const }
      : titlePageTypeRule
        ? { value: titlePageTypeRule[0], confidence: titlePageTypeRule[2], source: "title-page" as const }
        : firstPagesTypeRule
          ? { value: firstPagesTypeRule[0], confidence: firstPagesTypeRule[2], source: "first-pages" as const }
          : null;
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
  const firstPagesPeriodEvidence = [...pages.slice(1), ...imprintPages]
    .map((page) => page.text)
    .join("\n");
  const periodDecision = [
    derivePeriodCandidate(metadataText, "pdf-metadata", false),
    derivePeriodCandidate(input.filename, "filename", true),
    derivePeriodCandidate(firstPage, "title-page", false),
    derivePeriodCandidate(firstPagesPeriodEvidence, "first-pages", false),
  ].find((candidate): candidate is PeriodDecision => Boolean(candidate)) ?? null;
  const region = deriveRegion(evidence);
  const regionCandidates = [
    { source: "filename" as const, value: deriveRegion(input.filename) },
    { source: "pdf-metadata" as const, value: deriveRegion(metadataText) },
    { source: "title-page" as const, value: deriveRegion(firstPage) },
    { source: "first-pages" as const, value: deriveRegion(firstPages) },
  ];
  const regionSource = selectRegionSource(region, regionCandidates);
  return {
    type: typeDecision?.value ?? null,
    typeConfidence: typeDecision?.confidence ?? null,
    typeSource: typeDecision?.source ?? null,
    publicationName: titleDecision.value,
    publicationNameConfidence: titleDecision.confidence,
    publicationNameSource: titleDecision.source,
    editionLabel: periodDecision?.editionLabel ?? null,
    editionConfidence: periodDecision?.editionConfidence ?? null,
    editionSource: periodDecision?.editionLabel ? periodDecision.source : null,
    periodStartYear: periodDecision && periodDecision.periodStartYear > 0 ? periodDecision.periodStartYear : null,
    periodEndYear: periodDecision && periodDecision.periodEndYear > 0 ? periodDecision.periodEndYear : null,
    periodIssue: periodDecision?.periodIssue ?? null,
    periodConfidence: periodDecision && periodDecision.periodConfidence > 0 ? periodDecision.periodConfidence : null,
    periodSource: periodDecision && periodDecision.periodConfidence > 0 ? periodDecision.source : null,
    regionPlace: region.place,
    regionDistrict: region.district,
    regionState: region.state,
    regionConfidence: region.confidence,
    regionSource,
  };
}
