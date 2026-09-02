import { describe, expect, it } from "vitest";
import { areaSearchTerms } from "./search-terms.js";

describe("Gebietssuchbegriffe", () => {
  it("liefert eine begrenzte, deterministische deutsche Liste", () => {
    const first = areaSearchTerms("Böblingen", "district", 2026, "Landkreis");
    expect(first).toEqual(areaSearchTerms("Böblingen", "district", 2026, "Landkreis"));
    expect(first.length).toBeLessThanOrEqual(24);
    expect(first).toContain("Bürgerbroschüre Landkreis Böblingen");
    expect(first).toContain("Bürgerbroschüre PDF Landkreis Böblingen");
    expect(first).toContain("Bürgerbroschüre 2026 Landkreis Böblingen");
    expect(first).not.toContain("Bürgerbroschüre 2025 Landkreis Böblingen");
    expect(areaSearchTerms("Berlin", "district", 2026, "Kreisfreie Stadt"))
      .toContain("Bürgerbroschüre Berlin");
    expect(first.every((term) => !term.includes("Buergerbroschuere"))).toBe(true);
    expect(new Set(first).size).toBe(first.length);
  });

  it("verwendet natürliche Kreisbegriffe und lässt Bundesland weg", () => {
    expect(areaSearchTerms("Böblingen", "district", 2026, "Landkreis")[0])
      .toBe("Seniorenwegweiser Landkreis Böblingen");
    expect(areaSearchTerms("Bayern", "state", 2026, "Bundesland")[0])
      .toBe("Seniorenwegweiser Bayern");
    expect(areaSearchTerms("Berlin", "state", 2026, "Bundesland"))
      .not.toContain("Seniorenwegweiser Bundesland Berlin");
  });

  it("erweitert die Suchbegriffe im intensiven Modus", () => {
    const terms = areaSearchTerms(
      "Kitzingen",
      "district",
      2026,
      "Landkreis",
      { intensive: true },
    );
    expect(terms).toContain("Bürgerinformationsbroschüre Landkreis Kitzingen");
    expect(terms).toContain("mit freundlicher Unterstützung der Inserenten Kitzingen");
    expect(terms.length).toBeGreaterThan(24);
    expect(terms.length).toBeLessThanOrEqual(96);
    expect(new Set(terms).size).toBe(terms.length);
  });
});
