import { describe, expect, it } from "vitest";
import {
  downloadOccurrenceExport,
  evidenceLabel,
  occurrenceExportPath,
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
});
