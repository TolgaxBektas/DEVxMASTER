import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { areaGeometrySource } from "./data/area-geometry.de.js";
import { areaStage, type MapArea } from "./ui/AreaMap.js";

type AreaRecord = {
  level: string;
  ags: string;
};

type Geometry = {
  districts: Array<{
    ags: string;
    path: string;
  }>;
};

const areas = JSON.parse(readFileSync(
  new URL("./data/areas.de.json", import.meta.url),
  "utf8",
)) as AreaRecord[];
const geometry = JSON.parse(areaGeometrySource) as Geometry;
const now = Date.parse("2026-01-15T12:00:00.000Z");

const area = (overrides: Partial<MapArea> = {}): MapArea => ({
  ags: "01001",
  name: "Testgebiet",
  stateName: "Testland",
  status: "done",
  lastRunAt: null,
  nextDueAt: "2026-02-15T12:00:00.000Z",
  lastError: null,
  foundSources: 0,
  incompleteRuns: 0,
  ...overrides,
});

describe("Gebietskarte", () => {
  it("ordnet alle Gebietsstati korrekt zu", () => {
    expect(areaStage(undefined, now)).toBe("unknown");
    expect(areaStage(area({ status: "running" }), now)).toBe("running");
    expect(areaStage(area({ status: "pending" }), now)).toBe("pending");
    expect(areaStage(area({
      nextDueAt: "2026-02-15T12:00:00.000Z",
      lastError: "discovery_incomplete: Host nicht beantwortet",
    }), now)).toBe("incomplete");
    expect(areaStage(area({
      nextDueAt: "2026-01-14T12:00:00.000Z",
      lastError: null,
    }), now)).toBe("due");
    expect(areaStage(area({
      foundSources: 3,
      nextDueAt: "2026-02-15T12:00:00.000Z",
    }), now)).toBe("harvested");
    expect(areaStage(area({
      foundSources: 0,
      nextDueAt: "2026-02-15T12:00:00.000Z",
    }), now)).toBe("empty");
  });

  it("deckt genau die 400 Distrikte des Gebietsregisters ab", () => {
    const districtAreas = areas.filter((entry) => entry.level === "district");
    const areaAgs = new Set(districtAreas.map((entry) => entry.ags));
    const geometryAgs = new Set(geometry.districts.map((district) => district.ags));

    expect(districtAreas).toHaveLength(400);
    expect(geometry.districts).toHaveLength(400);
    expect(geometryAgs).toEqual(areaAgs);
    for (const district of geometry.districts) {
      expect(district.path.trim()).not.toBe("");
    }
  });
});
