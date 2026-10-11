import { describe, expect, it } from "vitest";
import { areaStage, type MapArea } from "./AreaMap.js";

describe("Suchschlüssel-Abdeckung in der Gebietsansicht", () => {
  it("lässt Gebiete mit unerledigten oder fehlerhaften Schlüsseln offen", () => {
    const area = {
      ags: "01001",
      name: "Alpha",
      stateName: "Land",
      status: "done",
      lastRunAt: null,
      nextDueAt: null,
      lastError: null,
      foundSources: 2,
      incompleteRuns: 0,
      searchKeyCoverage: {
        kreis: {
          total: 3,
          searched: 2,
          errors: 1,
          withHits: 2,
          lastSearchedAt: null,
        },
      },
    } as MapArea;
    expect(areaStage(area, Date.now())).toBe("pending");
  });
});
