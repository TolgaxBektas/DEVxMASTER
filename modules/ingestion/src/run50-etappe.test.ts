import { describe, expect, it } from "vitest";
import {
  deriveRun50EtappeAreaFromContacts,
  parseRun50EtappeExclusionList,
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
    expect(parseRun50EtappeArguments([
      "--mandant", "7",
      "--etappe", "stage-1",
      "--anteil", "5",
      "--max-seiten", "120",
    ]).maxPages).toBe(120);
    expect(parseRun50EtappeArguments([
      "--mandant", "7",
      "--etappe", "stage-1",
      "--anteil", "5",
      "--ausschliessen", "/tmp/testdateien.txt",
    ]).exclusionFile).toBe("/tmp/testdateien.txt");
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
    [["--mandant", "1", "--etappe", "s", "--anteil", "5", "--max-seiten"], "--max-seiten"],
    [["--mandant", "1", "--etappe", "s", "--anteil", "5", "--max-seiten", "0"], "positive Ganzzahl"],
    [["--mandant", "1", "--etappe", "s", "--anteil", "5", "--max-seiten", "12.5"], "positive Ganzzahl"],
    [["--mandant", "1", "--etappe", "s", "--anteil", "5", "--max-seiten", "12", "--max-seiten", "20"], "darf nur einmal"],
    [["--mandant", "1", "--etappe", "s", "--anteil", "5", "--ausschliessen"], "--ausschliessen"],
    [["--mandant", "1", "--etappe", "s", "--anteil", "5", "--ausschliessen", "a.txt", "--ausschliessen", "b.txt"], "darf nur einmal"],
    [["--mandant", "1", "--etappe", "s", "--anteil", "5", "--unbekannt"], "Unbekanntes"],
  ])("lehnt ungültige Argumente ab", (args, message) => {
    expect(() => parseRun50EtappeArguments(args)).toThrow(message);
  });

  it("leitet die Mehrheitsstadt ab und löst Postleitzahlengleichstände alphabetisch", () => {
    expect(deriveRun50EtappeAreaFromContacts([
      { city: " Passau ", postalCode: "94032" },
      { city: "Passau", postalCode: "94034" },
      { city: "Passau", postalCode: null },
      { city: "Nürnberg", postalCode: "90402" },
    ])).toEqual({
      city: "Passau",
      postalCode: "94032",
      votes: 3,
      total: 4,
    });
  });

  it("löst Mehrheitsgleichstände bei Städten alphabetisch auf", () => {
    expect(deriveRun50EtappeAreaFromContacts([
      { city: "Zwickau", postalCode: "08056" },
      { city: "Augsburg", postalCode: "86150" },
    ])).toEqual({
      city: "Augsburg",
      postalCode: "86150",
      votes: 1,
      total: 2,
    });
  });

  it("normalisiert Leerzeichen in Städten vor dem Stimmenzählen", () => {
    expect(deriveRun50EtappeAreaFromContacts([
      { city: "  Bad\t Tölz ", postalCode: null },
      { city: "Bad   Tölz", postalCode: null },
    ])).toEqual({
      city: "Bad Tölz",
      postalCode: null,
      votes: 2,
      total: 2,
    });
  });

  it("ermittelt die Postleitzahl nur aus Kontakten der gewählten Stadt", () => {
    expect(deriveRun50EtappeAreaFromContacts([
      { city: "Passau", postalCode: "94032" },
      { city: "Passau", postalCode: null },
      { city: "Augsburg", postalCode: "00001" },
    ])?.postalCode).toBe("94032");
  });

  it("liefert bei Kontakten ohne Stadt keine Gebietsableitung", () => {
    expect(deriveRun50EtappeAreaFromContacts([
      { city: null, postalCode: "94032" },
      { city: "  ", postalCode: null },
    ])).toBeNull();
  });

  it("liest Ausschlusslisten mit Kommentaren, Leerzeilen und positiven IDs", () => {
    expect(parseRun50EtappeExclusionList(`
      # eigene Testdateien

      4 # Testupload
      12 weiterer Kommentar
      4
    `)).toEqual(new Set([4, 12]));
  });

  it("meldet ungültige Ausschlusszeilen mit Zeilennummer", () => {
    expect(() => parseRun50EtappeExclusionList("# Kommentar\n\n4 # ok\n0")).toThrow("Zeile 4");
    expect(() => parseRun50EtappeExclusionList("4abc")).toThrow("Zeile 1");
  });

  it("rundet das Seitenziel auf und berechnet fünf Prozent von 30.252 Seiten", () => {
    expect(run50EtappeTargetPages(30_252, 5)).toBe(1_513);
    expect(run50EtappeTargetPages(1, 0.1)).toBe(1);
  });

  const candidates: Run50EtappeCandidate[] = Array.from({ length: 10 }, (_, index) => ({
    documentId: index + 1,
    ags: index === 0 ? null : "09162",
    areaName: index === 0 ? null : "Passau",
    areaLabel: index === 0 ? "wird aus den Anzeigen ermittelt" : "09162 Passau",
    areaOrigin: index === 0 ? "offen" : "quelle",
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

  it("schließt Hefte über dem Seitenlimit vor der Auswahl aus", () => {
    const selected = selectRun50EtappeDocuments([
      ...candidates,
      {
        documentId: 11,
        ags: null,
        areaName: null,
        areaLabel: "wird aus den Anzeigen ermittelt",
        areaOrigin: "offen",
        pages: 550,
        filename: "4119.pdf",
        sha256: "f".repeat(64),
      },
    ], 11, "stage-1", 200);
    expect(selected).toHaveLength(10);
    expect(selected.every((item) => item.pages <= 200)).toBe(true);
  });

  it("wählt Kandidaten auch ohne AGS aus", () => {
    const candidate: Run50EtappeCandidate = {
      documentId: 42,
      ags: null,
      areaName: null,
      areaLabel: "Teststadt (12345), 1 von 1 Anzeigen",
      areaOrigin: "anzeigen",
      pages: 2,
      filename: "gebietslos.pdf",
      sha256: "a".repeat(64),
    };
    expect(selectRun50EtappeDocuments([candidate], 1, "stage-1")).toEqual([candidate]);
  });

  it("gibt bei einem unerreichbaren Ziel alle Kandidaten zurück und bei Ziel höchstens null keine", () => {
    expect(selectRun50EtappeDocuments(candidates, 11, "stage-1")).toHaveLength(10);
    expect(selectRun50EtappeDocuments(candidates, 0, "stage-1")).toEqual([]);
    expect(selectRun50EtappeDocuments(candidates, -1, "stage-1")).toEqual([]);
  });
});
