export type SearchKeyType = "verwaltung" | "ort" | "plz" | "kreis";
export type SearchTerm = { term: string; priority: number; active?: boolean };
export type SearchArea = {
  id: number;
  ags: string;
  name: string;
  kind: string;
  orderIndex: number;
};
export type SearchLocality = {
  postalCode: string;
  name: string;
  municipalityKey: string;
};
export type SearchAdministration = {
  scope: string;
  districtAgs: string;
};
export type SearchKeyDraft = {
  areaId: number;
  keyType: SearchKeyType;
  term: string;
  scope: string;
  query: string;
  areaOrderIndex: number;
  priority: number;
};
export type SearchKeyCoverage = {
  total: number;
  searched: number;
  errors: number;
  withHits: number;
  lastSearchedAt: Date | null;
};
export type SearchKeyCoverageByArea = Record<SearchKeyType, SearchKeyCoverage>;

export const DEFAULT_SEARCH_TERMS: ReadonlyArray<SearchTerm> = [
  { term: "Seniorenwegweiser", priority: 1 },
  { term: "Firmenregister", priority: 1 },
  { term: "Bürgerinformationsbroschüre", priority: 1 },
  { term: "Neubürgerbroschüre", priority: 1 },
  { term: "Broschüre", priority: 1 },
  { term: "Hochzeitsbroschüre", priority: 1 },
  { term: "Energiewegweiser", priority: 1 },
  { term: "Wegweiser", priority: 1 },
  { term: "Stadtplan", priority: 1 },
  { term: "Gewerbeverzeichnis", priority: 1 },
  { term: "Bürgerinformation", priority: 2 },
  { term: "Bürgerbroschüre", priority: 2 },
  { term: "Gesundheitsführer", priority: 2 },
  { term: "Branchenführer", priority: 2 },
  { term: "Gastgeberverzeichnis", priority: 2 },
  { term: "Vereinsmagazin", priority: 2 },
  { term: "Festschrift", priority: 2 },
  { term: "Stadtmagazin", priority: 2 },
];

const KEY_TYPE_ORDER: Record<SearchKeyType, number> = {
  verwaltung: 0,
  ort: 1,
  plz: 2,
  kreis: 3,
};

function addUnique(
  keys: Map<string, SearchKeyDraft>,
  candidate: SearchKeyDraft,
  preferAdministration = false,
) {
  const existing = keys.get(candidate.query);
  if (!existing || (preferAdministration && existing.keyType === "ort")) {
    keys.set(candidate.query, candidate);
  }
}

export function buildSearchKeys(input: {
  areas: SearchArea[];
  terms: SearchTerm[];
  localities: SearchLocality[];
  administrations: SearchAdministration[];
}): SearchKeyDraft[] {
  const areas = [...input.areas];
  const localities = [...new Map(input.localities.map((locality) => [
    `${locality.postalCode}\u0000${locality.name}\u0000${locality.municipalityKey}`,
    locality,
  ])).values()];
  const localitiesByArea = new Map<string, SearchLocality[]>();
  const areasByLocalityName = new Map<string, Set<string>>();
  const localitiesByPostal = new Map<string, Map<string, number>>();
  for (const locality of localities) {
    const ags = locality.municipalityKey.slice(0, 5);
    const inArea = localitiesByArea.get(ags) ?? [];
    inArea.push(locality);
    localitiesByArea.set(ags, inArea);
    const areaNames = areasByLocalityName.get(locality.name) ?? new Set<string>();
    areaNames.add(ags);
    areasByLocalityName.set(locality.name, areaNames);
    const counts = localitiesByPostal.get(locality.postalCode) ?? new Map<string, number>();
    counts.set(ags, (counts.get(ags) ?? 0) + 1);
    localitiesByPostal.set(locality.postalCode, counts);
  }

  const keys = new Map<string, SearchKeyDraft>();
  const sortedAreas = [...areas].sort((a, b) => a.orderIndex - b.orderIndex || a.ags.localeCompare(b.ags));
  const sortedTerms = input.terms.filter((term) => term.active !== false)
    .sort((a, b) => a.priority - b.priority || a.term.localeCompare(b.term, "de"));
  for (const term of sortedTerms) {
    const termKeys = new Map<string, SearchKeyDraft>();
    for (const area of sortedAreas) {
      const typePrefix = area.kind.trim()
        && !["Kreisfreie Stadt", "Stadtkreis"].includes(area.kind.trim())
        ? `${area.kind.trim()} `
        : "";
      addUnique(termKeys, {
        areaId: area.id,
        keyType: "kreis",
        term: term.term,
        scope: area.name,
        query: `${term.term} ${typePrefix}${area.name}`.trim(),
        areaOrderIndex: area.orderIndex,
        priority: term.priority,
      });

      const areaLocalities = localitiesByArea.get(area.ags) ?? [];
      const byName = new Map<string, SearchLocality[]>();
      for (const locality of areaLocalities) {
        const matching = byName.get(locality.name) ?? [];
        matching.push(locality);
        byName.set(locality.name, matching);
      }
      for (const [name, entries] of [...byName].sort(([a], [b]) => a.localeCompare(b, "de"))) {
        if (name === area.name) continue;
        const minPostalCode = [...new Set(entries.map((entry) => entry.postalCode))]
          .sort((a, b) => a.localeCompare(b, "de"))[0];
        const disambiguator = (areasByLocalityName.get(name)?.size ?? 0) > 1
          ? ` ${minPostalCode}`
          : "";
        addUnique(termKeys, {
          areaId: area.id,
          keyType: "ort",
          term: term.term,
          scope: name,
          query: `${term.term} ${name}${disambiguator}`,
          areaOrderIndex: area.orderIndex,
          priority: term.priority,
        });
      }
    }
    for (const [postalCode, districtCounts] of [...localitiesByPostal].sort(([a], [b]) => a.localeCompare(b, "de"))) {
      const winnerAgs = [...districtCounts].sort(([agsA, countA], [agsB, countB]) =>
        countB - countA || agsA.localeCompare(agsB, "de"),
      )[0]?.[0];
      const area = sortedAreas.find((candidate) => candidate.ags === winnerAgs);
      if (!area) continue;
      addUnique(termKeys, {
        areaId: area.id,
        keyType: "plz",
        term: term.term,
        scope: postalCode,
        query: `${term.term} ${postalCode}`,
        areaOrderIndex: area.orderIndex,
        priority: term.priority,
      });
    }
    for (const administration of input.administrations) {
      const area = sortedAreas.find((candidate) => candidate.ags === administration.districtAgs);
      if (!area) continue;
      addUnique(termKeys, {
        areaId: area.id,
        keyType: "verwaltung",
        term: term.term,
        scope: administration.scope,
        query: `${term.term} ${administration.scope}`,
        areaOrderIndex: area.orderIndex,
        priority: term.priority,
      }, true);
    }
    for (const key of termKeys.values()) addUnique(keys, key, key.keyType === "verwaltung");
  }
  return [...keys.values()].sort((a, b) =>
    a.priority - b.priority
    || KEY_TYPE_ORDER[a.keyType] - KEY_TYPE_ORDER[b.keyType]
    || a.areaOrderIndex - b.areaOrderIndex
    || a.query.localeCompare(b.query, "de"),
  );
}

export function searchKeyCoverage(
  areaIds: number[],
  keys: Array<{
    areaId: number;
    keyType: SearchKeyType;
    status: "pending" | "done" | "error";
    lastHitCount: number;
    lastSearchedAt: Date | null;
  }>,
): Map<number, SearchKeyCoverageByArea> {
  const result = new Map<number, SearchKeyCoverageByArea>();
  for (const areaId of areaIds) {
    result.set(areaId, {
      verwaltung: { total: 0, searched: 0, errors: 0, withHits: 0, lastSearchedAt: null },
      ort: { total: 0, searched: 0, errors: 0, withHits: 0, lastSearchedAt: null },
      plz: { total: 0, searched: 0, errors: 0, withHits: 0, lastSearchedAt: null },
      kreis: { total: 0, searched: 0, errors: 0, withHits: 0, lastSearchedAt: null },
    });
  }
  for (const key of keys) {
    const coverage = result.get(key.areaId)?.[key.keyType];
    if (!coverage) continue;
    coverage.total += 1;
    if (key.status === "done") coverage.searched += 1;
    if (key.status === "error") coverage.errors += 1;
    if (key.lastHitCount > 0) coverage.withHits += 1;
    if (
      key.lastSearchedAt
      && (!coverage.lastSearchedAt || key.lastSearchedAt > coverage.lastSearchedAt)
    ) {
      coverage.lastSearchedAt = key.lastSearchedAt;
    }
  }
  return result;
}
