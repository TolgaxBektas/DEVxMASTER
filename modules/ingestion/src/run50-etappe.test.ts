import { describe, expect, it } from "vitest";
import {
  parseRun50EtappeArguments,
  run50EtappeTargetPages,
  selectRun50EtappeDocuments,
  type Run50EtappeCandidate,
} from "./run50-etappe.js";

describe("Run50-Etappenplanung", () => {
  it("liest Pflichtargumente streng und bleibt ohne Anwenden im Probelauf", () => {
    expect(parseRun50EtappeArguments([
      "--mandant", "7",
      "--etappe", "stage-1",
      "--anteil", "5",
    ])).toEqual({
      tenantId: 7,
      etappe: "stage-1",
      anteil: 5,
      apply: false,
    });
    expect(parseRun50EtappeArguments([
      "--mandant", "7",
      "--etappe", "stage-1",
      "--anteil", "5.5",
      "--anwenden",
    ]).apply).toBe(true);
  });

  it.each([
    [["--mandant", "1", "--etappe", "s"], "--anteil"],
    [["--mandant", "1", "--anteil", "5"], "--etappe"],
    [["--etappe", "s", "--anteil", "5"], "--mandant"],
    [["--mandant", "0", "--etappe", "s", "--anteil", "5"], "Mandantenkennung"],
    [["--mandant", "1", "--etappe", "s", "--anteil", "0"], "größer 0"],
    [["--mandant", "1", "--etappe", "s", "--anteil", "100.01"], "höchstens 100"],
    [["--mandant", "1", "--etappe", "s", "--anteil", "1e1"], "Anteil"],
    [["--mandant", "1", "--etappe", "s", "--etappe", "other", "--anteil", "5"], "darf nur einmal"],
    [["--mandant", "1", "--etappe", "s", "--anteil", "5", "--anwenden", "--anwenden"], "darf nur einmal"],
    [["--mandant", "1", "--etappe", "s", "--anteil", "5", "--unbekannt"], "Unbekanntes"],
  ])("lehnt ungültige Argumente ab", (args, message) => {
    expect(() => parseRun50EtappeArguments(args)).toThrow(message);
  });

  it("rundet das Seitenziel auf und berechnet fünf Prozent von 30.252 Seiten", () => {
    expect(run50EtappeTargetPages(30_252, 5)).toBe(1_513);
    expect(run50EtappeTargetPages(1, 0.1)).toBe(1);
  });

  it("wählt deterministisch rundenweise nach AGS und SHA-256 bis zum Ziel", () => {
    const candidate = (
      documentId: number,
      ags: string,
      sha256: string,
      pages: number,
    ): Run50EtappeCandidate => ({
      documentId,
      ags,
      areaName: `Gebiet ${ags}`,
      pages,
      filename: `${documentId}.pdf`,
      sha256,
    });
    const candidates = [
      candidate(2, "00100", "b", 3),
      candidate(9, "00100", "a", 1),
      candidate(1, "00100", "a", 4),
      candidate(4, "00200", "z", 1),
      candidate(3, "00200", "a", 5),
      candidate(6, "00200", "zz", 100),
      candidate(5, "00300", "a", 2),
    ];

    const selected = selectRun50EtappeDocuments(candidates, 15);
    expect(selected.map((item) => item.documentId)).toEqual([1, 3, 5, 9, 4, 2]);
    expect(selected.reduce((total, item) => total + item.pages, 0)).toBe(16);
    expect(selected.some((item) => item.documentId === 6)).toBe(false);
    expect(selectRun50EtappeDocuments(candidates, 0)).toEqual([]);
  });
});
