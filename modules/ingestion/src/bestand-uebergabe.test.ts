import { describe, expect, it } from "vitest";
import {
  categorizeBestandHandoffs,
  parseBestandHandoffArguments,
} from "./bestand-uebergabe.js";

describe("Bestandsübergabe", () => {
  it.each(["1234", "12a45"])("lehnt ungültige AGS %s ab", (ags) => {
    expect(() => parseBestandHandoffArguments([
      "--mandant",
      "1",
      "--gebiet",
      ags,
    ])).toThrow("Gebietskennung");
  });

  it.each(["0", "-1", "x"])("lehnt ungültigen Mandanten %s ab", (tenantId) => {
    expect(() => parseBestandHandoffArguments([
      "--mandant",
      tenantId,
      "--gebiet",
      "09373",
    ])).toThrow("Mandantenkennung");
  });

  it("lehnt ein fehlendes --gebiet ab", () => {
    expect(() => parseBestandHandoffArguments(["--mandant", "1"]))
      .toThrow("--gebiet");
  });

  it("ordnet übergebene und eingereihte Funde mit Vorrang der Übergabe ein", () => {
    const result = categorizeBestandHandoffs([
      { id: 5, alreadyHandedOff: false, alreadyQueued: false },
      { id: 3, alreadyHandedOff: true, alreadyQueued: true },
      { id: 1, alreadyHandedOff: false, alreadyQueued: true },
      { id: 4, alreadyHandedOff: false, alreadyQueued: false },
      { id: 2, alreadyHandedOff: false, alreadyQueued: false },
    ]);

    expect(result.candidates.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(result.alreadyHandedOff.map((row) => row.id)).toEqual([3]);
    expect(result.alreadyQueued.map((row) => row.id)).toEqual([1]);
    expect(result.toEnqueue.map((row) => row.id)).toEqual([2, 4, 5]);
  });
});
