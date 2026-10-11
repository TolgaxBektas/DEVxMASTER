import { describe, expect, it } from "vitest";
import {
  deriveRun50EtappeAreaFromContacts,
  parseRun50EtappeDocumentList,
  parseRun50EtappeExclusionList,
  parseRun50EtappeArguments,
  run50EtappePeriodEndYear,
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
    expect(parseRun50EtappeArguments([
      "--mandant", "7",
      "--etappe", "stage-1",
      "--dokumente", "/tmp/hefte.tsv",
    ])).toEqual({
      tenantId: 7,
      etappe: "stage-1",
      apply: false,
      documentFile: "/tmp/hefte.tsv",
    });
    expect(() => parseRun50EtappeArguments([
      "--mandant", "7",
      "--etappe", "stage-1",
      "--anteil", "5",
      "--dokumente", "/tmp/hefte.tsv",
    ])).toThrow("schließen sich gegenseitig aus");
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
    [["--mandant", "1", "--etappe", "s", "--anteil", "5", "--dokumente"], "--dokumente"],
    [["--mandant", "1", "--etappe", "s", "--dokumente", "a.tsv", "--dokumente", "b.tsv"], "darf nur einmal"],
    [["--mandant", "1", "--etappe", "s", "--anteil", "5", "--unbekannt"], "Unbekanntes"],
  ])("lehnt ungültige Argumente ab", (args, message) => {
    expect(() => parseRun50EtappeArguments(args)).toThrow(message);
  });

  it("liest Dokumentlisten mit einer ID pro Zeile und dedupliziert IDs", () => {
    expect(parseRun50EtappeDocumentList("1105\n5372\n1105\n")).toEqual([1105, 5372]);
  });

  it("liest Dokumentlisten aus einer TSV-Spalte document_id", () => {
    expect(parseRun50EtappeDocumentList(
      "\uFEFFfilename\tdocument_id\tpages\nheft.pdf\t1105\t104\n",
    )).toEqual([1105]);
  });

  it("meldet ungültige Dokument-IDs mit Zeilennummer", () => {
    expect(() => parseRun50EtappeDocumentList("1105\nabc\n")).toThrow("Zeile 2");
    expect(() => parseRun50EtappeDocumentList(
      "filename\tdocument_id\nheft.pdf\t1.5",
    )).toThrow("Zeile 2");
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
    periodEndYear: new Date().getFullYear(),
    pages: 1,
    filename: `${index + 1}.pdf`,
    sha256: String(index + 1).padStart(64, "0"),
  }));

  it("schließt nur erkannte Jahre außerhalb des Aktualitätszeitraums aus", () => {
    const yearCandidates = [2024, 2025, 2026, null, 2027, 2023, 2022].map((periodEndYear, index) => ({
      ...candidates[0]!,
      documentId: index + 20,
      periodEndYear,
      sha256: String(index + 20).padStart(64, "0"),
    }));
    const previousAge = process.env.INGESTION_ACTUALITY_MAX_AGE_YEARS;
    try {
      delete process.env.INGESTION_ACTUALITY_MAX_AGE_YEARS;
      const selectedWithDefaultAge = selectRun50EtappeDocuments(
        yearCandidates,
        10,
        "stage-1",
        undefined,
        2026,
      );
      expect(selectedWithDefaultAge.map((item) => item.documentId).sort()).toEqual([20, 21, 22, 23, 24]);
      const filenameCandidates: Run50EtappeCandidate[] = [
        {
          ...candidates[0]!,
          documentId: 30,
          filename: "Mitteilungsblatt_2022.pdf",
          periodEndYear: run50EtappePeriodEndYear(null, "Mitteilungsblatt_2022.pdf"),
        },
        {
          ...candidates[0]!,
          documentId: 31,
          filename: "familienwegweiser_internet.pdf",
          periodEndYear: run50EtappePeriodEndYear(null, "familienwegweiser_internet.pdf"),
        },
        {
          ...candidates[0]!,
          documentId: 32,
          filename: "Mitteilungsblatt_2024.pdf",
          periodEndYear: run50EtappePeriodEndYear(null, "Mitteilungsblatt_2024.pdf"),
        },
        {
          ...candidates[0]!,
          documentId: 33,
          filename: "Amtsblatt_2022_2024.pdf",
          periodEndYear: run50EtappePeriodEndYear(null, "Amtsblatt_2022_2024.pdf"),
        },
      ];
      expect(selectRun50EtappeDocuments(
        filenameCandidates,
        10,
        "stage-filename",
        undefined,
        2026,
        2.5,
      ).map((item) => item.documentId).sort()).toEqual([31, 32, 33]);
    } finally {
      if (previousAge === undefined) {
        delete process.env.INGESTION_ACTUALITY_MAX_AGE_YEARS;
      } else {
        process.env.INGESTION_ACTUALITY_MAX_AGE_YEARS = previousAge;
      }
    }
  });

  it("bevorzugt das Klassifikationsjahr und nutzt sonst das Dateinamensjahr", () => {
    expect(run50EtappePeriodEndYear(2020, "Mitteilungsblatt_2022.pdf")).toBe(2020);
    expect(run50EtappePeriodEndYear(null, "Mitteilungsblatt_2022.pdf")).toBe(2022);
    expect(run50EtappePeriodEndYear(null, "familienwegweiser_internet.pdf")).toBeNull();
    expect(run50EtappePeriodEndYear(0, "Mitteilungsblatt_2022.pdf")).toBe(2022);
    expect(run50EtappePeriodEndYear(-1, "Mitteilungsblatt_2022.pdf")).toBe(2022);
  });

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
        periodEndYear: new Date().getFullYear(),
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
      periodEndYear: new Date().getFullYear(),
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
