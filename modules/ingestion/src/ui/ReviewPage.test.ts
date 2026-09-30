import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  AdvertiserProofDetails,
  resolveSelectedReviewId,
  ReviewProvenanceRows,
  reviewListCaption,
} from "./ReviewPage.js";

function renderedText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join(" ");
  if (!isValidElement(node)) return "";
  return renderedText((node.props as { children?: ReactNode }).children);
}

function findElement(node: ReactNode, type: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const element = findElement(child, type);
      if (element) return element;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return findElement((node.props as { children?: ReactNode }).children, type);
}

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

describe("Prüfseiten-Herkunft", () => {
  it("rendert Nachweislabels, Gebiet, Quelle und Heft", () => {
    const proof = AdvertiserProofDetails({
      advertiserProof: ["positiv:p1a", "positiv:p3"],
    });
    expect(renderedText(proof)).toContain("Inserenten-Nachweis");
    expect(renderedText(proof)).toContain("P1a Rechtsform");
    expect(renderedText(proof)).toContain("P3 Kontaktweg");

    const provenance = ReviewProvenanceRows({
      provenance: {
        area_name: "Musterkreis",
        area_ags: "09162",
        area_state: "Bayern",
        source_url: "https://example.test/amtsblatt.pdf",
        document_filename: "amtsblatt.pdf",
        publication: "Musterblatt",
        edition: "Ausgabe 4",
        year: 2026,
        issue: 4,
      },
    });
    const details = renderedText(provenance);
    expect(details).toContain("Gebiet");
    expect(details).toContain("Musterkreis · AGS 09162 · Bayern");
    expect(details).toContain("Quelle");
    expect(details).toContain("https://example.test/amtsblatt.pdf");
    expect(details).toContain("Heft");
    expect(details).toContain("Musterblatt · Ausgabe 4 · 2026 · Nr. 4");
    expect(details).toContain("Datei");
    expect(details).toContain("amtsblatt.pdf");
    expect(findElement(provenance, "a")?.props).toMatchObject({
      href: "https://example.test/amtsblatt.pdf",
      target: "_blank",
      rel: "noreferrer",
    });
    expect(reviewListCaption({
      page: 3,
      reason: "Menschliche Prüfung erforderlich",
      provenance: { area_name: "Musterkreis" },
    })).toBe("Musterkreis · Seite 3 · Menschliche Prüfung erforderlich");
  });

  it("zeigt fehlenden Nachweis und Herkunft ohne Metadaten stabil an", () => {
    const proof = AdvertiserProofDetails({});
    const provenance = ReviewProvenanceRows({ provenance: null });

    expect(renderedText(proof)).toContain("kein Nachweis übermittelt");
    expect(renderedText(provenance)).toContain("Gebiet");
    expect(renderedText(provenance)).toContain("Quelle");
    expect(renderedText(provenance)).toContain("Heft");
    expect(renderedText(provenance)).toContain("Datei");
    expect(renderedText(provenance).match(/—/g)).toHaveLength(4);
    expect(reviewListCaption({
      page: null,
      reason: "Menschliche Prüfung erforderlich",
      provenance: null,
    })).toBe("Seite — · Menschliche Prüfung erforderlich");
  });
});
