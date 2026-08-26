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
});
