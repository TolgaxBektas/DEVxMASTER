import { describe, expect, it } from "vitest";
import {
  collapseVerdicts,
  mergeEvidence,
  parseVerdictFile,
  plannedRejection,
  rejectionEvidence,
  updatedRowCount,
} from "./inserenten-test-verdicts.js";

describe("Urteile des Inserenten-Tests", () => {
  it("parst gequotete und mehrzeilige TSV-Felder", () => {
    const rows = parseVerdictFile([
      "occurrence_id\tdocument_id\tpage\tarea\tstatus_alt\tfirma\turteil_neu\tgrund",
      "12\t3\t4\tKreis\tdetected\t\"Muster\tGmbH\nZweigstelle\"\tkeine_anzeige\tveto:behoerde, positiv:p1a",
    ].join("\n"));
    expect(rows).toEqual([{
      occurrenceId: 12,
      verdict: "keine_anzeige",
      reason: "veto:behoerde, positiv:p1a",
    }]);
  });

  it("dedupliziert gleiche Urteile und weist Konflikte zurück", () => {
    expect(collapseVerdicts([
      { occurrenceId: 4, verdict: "keine_anzeige", reason: "veto:kirche" },
      { occurrenceId: 4, verdict: "keine_anzeige", reason: "veto:kirche" },
    ])).toHaveLength(1);
    expect(() => collapseVerdicts([
      { occurrenceId: 4, verdict: "keine_anzeige", reason: "" },
      { occurrenceId: 4, verdict: "firmenanzeige", reason: "" },
    ])).toThrow("Widersprüchliche Urteile");
  });

  it("übernimmt nur Ablehnungsgründe und schützt vor positiven Belegen", () => {
    expect(rejectionEvidence("veto:kirche")).toEqual(["veto:kirche"]);
    expect(rejectionEvidence("positiv:p1a, fehlend:kontakt, veto:verein")).toEqual([
      "fehlend:kontakt",
      "veto:verein",
    ]);
    expect(rejectionEvidence("positiv:p1a, positiv:p2")).toEqual(["veto:falscher-ausschnitt"]);
  });

  it("erhält vorhandene Belege und hängt neue ohne Duplikate an", () => {
    expect(mergeEvidence(["geometry", "veto:kirche"], ["veto:kirche", "fehlend:kontakt"]))
      .toEqual(["geometry", "veto:kirche", "fehlend:kontakt"]);
    expect(mergeEvidence(null, ["veto:kirche"])).toEqual(["veto:kirche"]);
  });

  it("plant nur offene negative Fundstellen zur Ablehnung ein", () => {
    expect(plannedRejection({ status: "detected" }, "keine_anzeige")).toBe(true);
    expect(plannedRejection({ status: "approved" }, "keine_anzeige")).toBe(false);
    expect(plannedRejection({ status: "rejected" }, "keine_anzeige")).toBe(false);
    expect(plannedRejection({ status: "detected" }, "firmenanzeige")).toBe(false);
  });

  it("liest die betroffenen Zeilen aus beiden MySQL-Ergebnisformen", () => {
    expect(updatedRowCount([{ affectedRows: 1 }])).toBe(1);
    expect(updatedRowCount({ affectedRows: 1 })).toBe(1);
    expect(updatedRowCount(undefined)).toBe(0);
    expect(updatedRowCount([])).toBe(0);
  });
});
