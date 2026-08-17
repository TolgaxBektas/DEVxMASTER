import { describe, expect, it } from "vitest";
import {
  evidenceLabel,
  occurrenceImageFallbackVisible,
} from "./ui/OccurrencesPage.js";

describe("Fundstellenansicht", () => {
  it("übersetzt alle technischen Evidenzen ohne rohe Werte", () => {
    expect(evidenceLabel("typography")).toBe("Typografische Gestaltung");
    expect(evidenceLabel("whitespace")).toBe("Freiraum um die Anzeige");
    expect(evidenceLabel("future-signal")).toBe("Zusätzlicher Prüfbeleg");
  });

  it("zeigt den fehlenden Ausschnitt nur im Fehlerzustand", () => {
    expect(occurrenceImageFallbackVisible("loading")).toBe(false);
    expect(occurrenceImageFallbackVisible("loaded")).toBe(false);
    expect(occurrenceImageFallbackVisible("missing")).toBe(true);
  });
});
