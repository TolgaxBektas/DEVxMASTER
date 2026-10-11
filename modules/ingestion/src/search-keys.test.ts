import { describe, expect, it } from "vitest";
import { buildSearchKeys, DEFAULT_SEARCH_TERMS, searchKeyCoverage } from "./search-keys.js";

const areas = [
  { id: 1, ags: "01001", name: "Kreis A", kind: "Landkreis", orderIndex: 1 },
  { id: 2, ags: "01002", name: "Kreis B", kind: "Landkreis", orderIndex: 2 },
];
const term = [{ term: "Seniorenwegweiser", priority: 1 }];

describe("feste Suchschlüssel", () => {
  it("seedet zehn vorgegebene Begriffe mit Priorität 1 und acht mit Priorität 2", () => {
    expect(DEFAULT_SEARCH_TERMS).toHaveLength(18);
    expect(DEFAULT_SEARCH_TERMS.filter((item) => item.priority === 1)).toHaveLength(10);
    expect(DEFAULT_SEARCH_TERMS.filter((item) => item.priority === 2)).toHaveLength(8);
  });

  it("bildet Kreis-, Orts- und PLZ-Schlüssel deterministisch und disambiguiert gleiche Ortsnamen", () => {
    const keys = buildSearchKeys({
      areas,
      terms: term,
      localities: [
        { postalCode: "10001", name: "Dorf", municipalityKey: "01001001" },
        { postalCode: "10001", name: "Dorf", municipalityKey: "01001001" },
        { postalCode: "10005", name: "Dorf", municipalityKey: "01001002" },
        { postalCode: "10002", name: "Dorf", municipalityKey: "01002001" },
        { postalCode: "10003", name: "Kreis A", municipalityKey: "01001002" },
      ],
      administrations: [],
    });
    expect(keys).toContainEqual(expect.objectContaining({
      keyType: "kreis", query: "Seniorenwegweiser Landkreis Kreis A",
    }));
    expect(keys).toContainEqual(expect.objectContaining({
      keyType: "ort", query: "Seniorenwegweiser Dorf 10001", areaId: 1,
    }));
    expect(keys).toContainEqual(expect.objectContaining({
      keyType: "ort", query: "Seniorenwegweiser Dorf 10002", areaId: 2,
    }));
    expect(keys.filter((key) => key.keyType === "ort" && key.areaId === 1 && key.scope === "Dorf"))
      .toHaveLength(1);
    expect(keys.some((key) => key.keyType === "ort" && key.scope === "Kreis A")).toBe(false);
    expect(keys.filter((key) => key.keyType === "plz" && key.scope === "10001")).toHaveLength(1);
    expect(buildSearchKeys({
      areas,
      terms: term,
      localities: [
        { postalCode: "10001", name: "Dorf", municipalityKey: "01001001" },
        { postalCode: "10001", name: "Dorf", municipalityKey: "01001001" },
        { postalCode: "10005", name: "Dorf", municipalityKey: "01001002" },
        { postalCode: "10002", name: "Dorf", municipalityKey: "01002001" },
        { postalCode: "10003", name: "Kreis A", municipalityKey: "01001002" },
      ],
      administrations: [],
    })).toEqual(keys);
  });

  it("ordnet eine PLZ nach Locality-Mehrheit und bei Gleichstand dem kleinsten AGS zu", () => {
    const keys = buildSearchKeys({
      areas,
      terms: term,
      localities: [
        { postalCode: "20000", name: "A", municipalityKey: "01002001" },
        { postalCode: "20000", name: "B", municipalityKey: "01002002" },
        { postalCode: "20001", name: "C", municipalityKey: "01002003" },
        { postalCode: "20001", name: "D", municipalityKey: "01001001" },
      ],
      administrations: [],
    });
    expect(keys.find((key) => key.keyType === "plz" && key.scope === "20000")?.areaId).toBe(2);
    expect(keys.find((key) => key.keyType === "plz" && key.scope === "20001")?.areaId).toBe(1);
  });

  it("gibt einer Verwaltung Vorrang vor einem gleichlautenden Ortsschlüssel", () => {
    const keys = buildSearchKeys({
      areas,
      terms: term,
      localities: [{ postalCode: "30000", name: "Willingen", municipalityKey: "01001001" }],
      administrations: [{ scope: "Willingen", districtAgs: "01001" }],
    });
    expect(keys.filter((key) => key.query === "Seniorenwegweiser Willingen")).toEqual([
      expect.objectContaining({ keyType: "verwaltung", areaId: 1 }),
    ]);
  });

  it("lässt inaktive Begriffe aus und sortiert aktive Schlüssel nach Begriffspriorität", () => {
    const keys = buildSearchKeys({
      areas,
      terms: [
        { term: "Sekundär", priority: 2 },
        { term: "Inaktiv", priority: 1, active: false },
        { term: "Primär", priority: 1 },
      ],
      localities: [],
      administrations: [],
    });
    expect(keys.map((key) => key.term)).toEqual([
      "Primär", "Primär", "Sekundär", "Sekundär",
    ]);
  });

  it("zählt nur done als durchsucht und hält Fehler getrennt", () => {
    const coverage = searchKeyCoverage([1], [
      { areaId: 1, keyType: "ort", status: "done", lastHitCount: 2, lastSearchedAt: new Date("2026-01-01") },
      { areaId: 1, keyType: "ort", status: "error", lastHitCount: 0, lastSearchedAt: null },
      { areaId: 1, keyType: "kreis", status: "pending", lastHitCount: 0, lastSearchedAt: null },
    ]).get(1);
    expect(coverage?.ort).toMatchObject({ total: 2, searched: 1, errors: 1, withHits: 1 });
    expect(coverage?.kreis).toMatchObject({ total: 1, searched: 0, errors: 0 });
  });
});
