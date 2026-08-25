import { unzipSync } from "fflate";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { NoopStorage } from "@xmaster-center/integrations";
import { MemoryIngestionRepository } from "./memory-repository.js";
import {
  buildOccurrenceExportRows,
  createOccurrenceExportZip,
  occurrenceExportHeaders,
  attachOccurrenceExportImages,
} from "./rest.js";

function seedRepository() {
  const repository = new MemoryIngestionRepository();
  repository.documents.push(
    {
      id: 1,
      tenantId: "1",
      sourceId: null,
      filename: "heft.pdf",
      sha256: "a",
      storageKey: "originals/a.pdf",
      sizeBytes: 5,
      mimeType: "application/pdf",
      origin: "upload",
      state: "processed",
      error: null,
      classification: {
        type: "publication",
        typeSource: "filename",
        typeConfidence: 1,
        publicationName: "Kommunalheft",
        publicationNameSource: "filename",
        publicationNameConfidence: 1,
        editionLabel: "Ausgabe 4",
        editionSource: "filename",
        editionConfidence: 1,
        periodStartYear: 2024,
        periodEndYear: null,
        periodIssue: null,
        periodSource: "filename",
        periodConfidence: 1,
        regionState: null,
        regionDistrict: null,
        regionPlace: null,
        regionSource: "filename",
        regionConfidence: null,
        derivedAt: null,
        correctedAt: null,
        correctedBy: null,
        actualityStatus: "current",
        actualityDecidedAt: null,
        actualityDecidedBy: null,
      },
      actualityStatus: "current",
      actualitySource: "derived",
      actualityDecidedAt: null,
      actualityDecidedBy: null,
    },
    {
      id: 2,
      tenantId: "2",
      sourceId: null,
      filename: "anderes.pdf",
      sha256: "b",
      storageKey: "originals/b.pdf",
      sizeBytes: 5,
      mimeType: "application/pdf",
      origin: "upload",
      state: "processed",
      error: null,
      classification: null,
      actualityStatus: "unverified",
      actualitySource: "derived",
      actualityDecidedAt: null,
      actualityDecidedBy: null,
    },
  );
  repository.occurrences.push(
    {
      id: 11,
      documentId: 1,
      pageNumber: 3,
      company: "Muster GmbH",
      preview: "Muster-Anzeige",
      status: "detected",
      imageKey: "tenants/1/ad.png",
      confidence: 0.9,
      evidence: ["geometry"],
      contacts: {
        phone: "01234 567890",
        email: "info@muster.example",
        website: "www.muster.example",
        postalCode: "12345",
        city: "Musterstadt",
      },
    },
    {
      id: 12,
      documentId: 1,
      pageNumber: 4,
      company: "Ohne Bild",
      preview: "Zweite Anzeige",
      status: "approved",
      imageKey: null,
      confidence: null,
      evidence: [],
      contacts: null,
    },
    {
      id: 21,
      documentId: 2,
      pageNumber: 1,
      company: "Fremder Mandant",
      preview: "Nicht exportieren",
      status: "detected",
      imageKey: "tenants/2/ad.png",
      confidence: 0.2,
      evidence: [],
      contacts: null,
    },
  );
  const classifiedDocument = repository.documents[0];
  if (classifiedDocument?.classification) {
    repository.classifications.set("1:1", classifiedDocument.classification);
  }
  return repository;
}

describe("Fundstellen-Export", () => {
  it("liefert die Spalten und Zeilen nur für den authentifizierten Mandanten", async () => {
    const rows = await buildOccurrenceExportRows(seedRepository(), "1");
    expect(occurrenceExportHeaders).toEqual([
      "Firma", "Telefon", "E-Mail", "Website", "PLZ/Ort", "Heft",
      "Ausgabe", "Seite", "Jahr", "Aktualität", "Status", "Zuversicht",
      "Belege", "Anzeigentext", "Bilddatei", "Fundstelle-ID", "Dokument-ID",
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.values).toEqual([
      "Muster GmbH", "01234 567890", "info@muster.example", "www.muster.example",
      "12345 Musterstadt", "Kommunalheft", "Ausgabe 4", 3, "2024", "current",
      "detected", 0.9, "geometry", "Muster-Anzeige",
      "bilder/11-Muster_GmbH.png", 11, 1,
    ]);
    expect(rows[1]?.values[8]).toBe("2024");
    expect(rows[1]?.imageKey).toBeNull();
  });

  it("wendet Dokument- und Statusfilter an und lässt ein unbelegtes Jahr leer aus", async () => {
    const repository = seedRepository();
    const document = repository.documents[0];
    if (!document) throw new Error("Testdokument fehlt");
    document.classification = null;
    repository.classifications.delete("1:1");
    const rows = await buildOccurrenceExportRows(repository, "1", {
      documentId: 1,
      status: "approved",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.values[8]).toBe("unbelegt");
    expect(rows[0]?.values[15]).toBe(12);
  });

  it("kann fehlende Ausschnitte ohne falschen Zugriffspunkt behandeln", async () => {
    const rows = await buildOccurrenceExportRows(seedRepository(), "1", { status: "detected" });
    const storage = new NoopStorage();
    expect(await storage.get(rows[0]?.sourceImageKey ?? "")).toBeNull();
    expect(rows[0]?.imageKey).toBe("bilder/11-Muster_GmbH.png");
  });

  it("leert fehlende Bildpfade vor der Tabellenerzeugung", async () => {
    const rows = await buildOccurrenceExportRows(seedRepository(), "1", { status: "detected" });
    await attachOccurrenceExportImages(rows, new NoopStorage());
    const imagePathIndex = occurrenceExportHeaders.indexOf("Bilddatei");
    expect(rows[0]?.values[imagePathIndex]).toBe("");
  });

  it("legt keinen leeren Bilder-Ordner als ZIP-Eintrag an", async () => {
    const rows = await buildOccurrenceExportRows(seedRepository(), "1", { status: "detected" });
    const archive = await createOccurrenceExportZip(rows, new NoopStorage());
    expect(archive.includes(Buffer.from("anzeigen.xlsx"))).toBe(true);
    expect(archive.includes(Buffer.from("bilder/"))).toBe(false);
  });

  it("erzeugt ein lesbares XLSX im fertigen ZIP", async () => {
    const rows = await buildOccurrenceExportRows(seedRepository(), "1", { status: "detected" });
    const archive = await createOccurrenceExportZip(rows, new NoopStorage());
    const files = unzipSync(archive);
    const workbookBytes = files["anzeigen.xlsx"];
    if (!workbookBytes) throw new Error("anzeigen.xlsx fehlt im Export-ZIP");
    const workbook = new ExcelJS.Workbook();
    const xlsxData = workbookBytes as unknown as Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(xlsxData);
    const sheet = workbook.getWorksheet("Anzeigen");
    expect(sheet).toBeDefined();
    expect(sheet?.getRow(1).values).toEqual([
      undefined,
      ...occurrenceExportHeaders,
    ]);
    expect(sheet?.getRow(2).getCell(1).value).toBe("Muster GmbH");
    expect(sheet?.getRow(2).getCell(occurrenceExportHeaders.indexOf("Fundstelle-ID") + 1).value).toBe(11);
  });
});
