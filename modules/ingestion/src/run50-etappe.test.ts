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

  const candidates: Run50EtappeCandidate[] = Array.from({ length: 10 }, (_, index) => ({
    documentId: index + 1,
    ags: "09162",
    areaName: "Passau",
    pages: 1,
    filename: `${index + 1}.pdf`,
    sha256: String(index + 1).padStart(64, "0"),
  }));

  it("ist für dieselbe Etappe deterministisch und variiert zwischen Etappen", () => {
    const firstEtappe = selectRun50EtappeDocuments(candidates, 10, "stage-1")
      .map((item) => item.documentId);
    expect(selectRun50EtappeDocuments(candidates, 10, "stage-1").map((item) => item.documentId))
      .toEqual(firstEtappe);
    expect(selectRun50EtappeDocuments(candidates, 10, "stage-2").map((item) => item.documentId))
      .not.toEqual(firstEtappe);
  });

  it("stoppt unmittelbar, sobald die Zielseitenzahl erreicht ist", () => {
    const selected = selectRun50EtappeDocuments(
      candidates.map((item) => ({ ...item, pages: 2 })),
      3,
      "stage-1",
    );
    expect(selected).toHaveLength(2);
    expect(selected.reduce((total, item) => total + item.pages, 0)).toBe(4);
  });

  it("gibt bei einem unerreichbaren Ziel alle Kandidaten zurück und bei Ziel höchstens null keine", () => {
    expect(selectRun50EtappeDocuments(candidates, 11, "stage-1")).toHaveLength(10);
    expect(selectRun50EtappeDocuments(candidates, 0, "stage-1")).toEqual([]);
    expect(selectRun50EtappeDocuments(candidates, -1, "stage-1")).toEqual([]);
  });
});
