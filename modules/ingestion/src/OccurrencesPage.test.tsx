import { describe, expect, it } from "vitest";
import {
  applyOccurrenceReviewStatuses,
  downloadOccurrenceExport,
  evidenceLabel,
  formatOccurrenceProvenance,
  occurrenceExportPath,
  occurrenceImageFallbackVisible,
  reconcileOccurrenceReviewStatuses,
} from "./ui/OccurrencesPage.js";

describe("Fundstellenansicht", () => {
  it("formatiert die Herkunft vollständig und markiert Altfunde", () => {
    const rows = formatOccurrenceProvenance({
      occurrenceId: 1,
      dataSource: "xdata_germany",
      company: "Muster GmbH",
      status: "detected",
      confidence: 0.9,
      bbox: null,
      imageKey: null,
      evidence: ["geometry", "positiv:p2"],
      advertiserProof: ["positiv:p2"],
      page: { id: 2, number: 4 },
      document: {
        id: 3,
        filename: "heft.pdf",
        sha256: "abcdef1234567890",
        origin: "upload",
        storageKey: "heft.pdf",
      },
      source: null,
      area: null,
      publication: null,
    });
    expect(rows.find((row) => row.label === "Datenquelle")?.value).toBe("xDATA Germany");
    expect(rows.find((row) => row.label === "Dokument-SHA-256")?.value).toBe("abcdef123456");
    expect(rows.find((row) => row.label === "Inserenten-Nachweis")?.value).toBe("P2 Werbeabsicht");
  });

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

  it("übernimmt den Statusfilter in den Excel-Download", async () => {
    const click = () => undefined;
    const fetcher = async (path: RequestInfo | URL) => {
      expect(String(path)).toBe(occurrenceExportPath("approved"));
      return new Response(new Blob(["zip"]), { status: 200 });
    };
    const createObjectURL = () => "blob:export";
    const revokeObjectURL = () => undefined;
    const documentRef = {
      createElement: () => ({
        href: "",
        download: "",
        click,
      } as unknown as HTMLAnchorElement),
    };
    await downloadOccurrenceExport("approved", {
      fetcher,
      documentRef,
      urlRef: { createObjectURL, revokeObjectURL },
    });
  });

  it("meldet einen fehlgeschlagenen Excel-Download", async () => {
    await expect(downloadOccurrenceExport("detected", {
      fetcher: async () => new Response(null, { status: 403 }),
      documentRef: { createElement: () => {
        throw new Error("Darf nicht aufgerufen werden");
      } },
      urlRef: { createObjectURL: () => "unused", revokeObjectURL: () => undefined },
    })).rejects.toThrow("Excel-Paket konnte nicht heruntergeladen werden.");
  });

  it("zeigt eine erfolgreiche Entscheidung sofort im lokalen Kartenstatus", () => {
    const rows = applyOccurrenceReviewStatuses(
      [{ id: 7, company: "Muster GmbH", status: "detected" }],
      { 7: "approved" },
    );
    expect(rows[0]).toMatchObject({ id: 7, status: "approved" });
  });

  it("übernimmt nach dem Serverabgleich wieder den Serverstatus", () => {
    const rows = applyOccurrenceReviewStatuses(
      [{ id: 7, company: "Muster GmbH", status: "approved" }],
      {},
    );
    expect(rows[0]).toMatchObject({ id: 7, status: "approved" });
  });

  it("verwirft eine widersprüchliche Serverentscheidung", () => {
    const decisions = reconcileOccurrenceReviewStatuses(
      [{ id: 7, company: "Muster GmbH", status: "rejected" }],
      { 7: "approved" },
    );
    expect(applyOccurrenceReviewStatuses(
      [{ id: 7, company: "Muster GmbH", status: "rejected" }],
      decisions,
    )[0]?.status).toBe("rejected");
  });

  it("verwirft lokale Entscheidungen für verschwundene Fundstellen", () => {
    expect(reconcileOccurrenceReviewStatuses([], { 7: "approved" })).toEqual({});
  });

  it("behält lokale Entscheidungen bei offenem Serverstand", () => {
    expect(reconcileOccurrenceReviewStatuses(
      [{ id: 7, company: "Muster GmbH", status: "detected" }],
      { 7: "approved" },
    )).toEqual({ 7: "approved" });
  });
});
