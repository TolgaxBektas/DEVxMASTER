import { describe, expect, it } from "vitest";
import { resolveSelectedReviewId } from "./ReviewPage.js";

describe("Prüfseiten-Auswahl", () => {
  it("wählt nach dem Wechsel und Zurückwechseln wieder den aktiven Warteschlangenfall", () => {
    const highQualityItems = [{ id: 1 }];
    const germanyItems: { id: number }[] = [];

    expect(resolveSelectedReviewId(highQualityItems, null)).toBe(1);
    expect(resolveSelectedReviewId(germanyItems, null)).toBeNull();
    expect(resolveSelectedReviewId(highQualityItems, null)).toBe(1);
  });

  it("fällt auf den ersten Fall zurück, wenn der gemerkte Fall nicht mehr offen ist", () => {
    expect(resolveSelectedReviewId([{ id: 2 }, { id: 3 }], 9)).toBe(2);
    expect(resolveSelectedReviewId([{ id: 2 }, { id: 3 }], 3)).toBe(3);
  });
});
