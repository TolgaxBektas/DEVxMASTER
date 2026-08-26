import { describe, expect, it } from "vitest";
import { areaSearchTerms } from "./search-terms.js";

describe("Gebietssuchbegriffe", () => {
  it("liefert eine begrenzte, deterministische deutsche Liste", () => {
    const first = areaSearchTerms("Köln", "district", 2026);
    expect(first).toEqual(areaSearchTerms("Köln", "district", 2026));
    expect(first.length).toBeLessThanOrEqual(72);
    expect(first).toContain("Bürgerbroschüre Köln Kreis");
    expect(first).toContain("Bürgerbroschüre 2026 Köln Kreis");
    expect(first).toContain("Bürgerbroschüre 2025 Köln Kreis");
    expect(first.every((term) => !term.includes("Buergerbroschuere"))).toBe(true);
    expect(new Set(first).size).toBe(first.length);
  });
});
