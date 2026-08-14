import { describe, expect, it } from "vitest";
import { MemoryEventRepository } from "@xmaster-center/kernel";
import { MemoryIngestionRepository } from "./memory-repository.js";
import { advertisementEventIdempotencyKey, createIngestionModule } from "./module.js";
import { deriveDocumentClassification } from "./classification.js";
import { classificationCorrectionSchema } from "./router.js";

const context = (tenantId: string | null, payload: unknown) => ({
  job: { tenantId, payload },
});

describe("Ingestion-Bestand", () => {
  it("leitet Arten, Zeitraum und strukturierte Regionen aus echten Titeltexten ab", () => {
    const result = deriveDocumentClassification({
      filename: "Seniorenwegweiser.pdf",
      pages: [{
        pageNumber: 1,
        text: "LEBEN UND ÄLTER WERDEN IM RHEIN-NECKAR-KREIS\nBaden-Württemberg\nAUSGABE 2020",
      }],
    });
    expect(result.type).toBe("bürger-und-seniorenwegweiser");
    expect(result.regionDistrict).toBe("Rhein-Neckar-Kreis");
    expect(result.regionState).toBe("Baden-Württemberg");
    expect(result.periodStartYear).toBe(2020);
    expect(result.periodEndYear).toBe(2020);
    expect(result.typeConfidence).toBeGreaterThan(0.9);
    expect(result.editionLabel).toBe("Ausgabe 2020");
  });

  it("erkennt die vereinbarten Publikationsarten ohne KI", () => {
    const examples = [
      ["Amtsblatt der Gemeinde Oststeinbek.pdf", "AMTSBLATT DER GEMEINDE OSTSTEINBEK", "kommunales-amtsblatt"],
      ["Stadtmagazin Aachen.pdf", "STADTMAGAZIN AACHEN", "stadt-und-gemeindemagazin"],
      ["Seniorenwegweiser.pdf", "SENIORENWEGWEISER", "bürger-und-seniorenwegweiser"],
      ["Branchenführer 2024.pdf", "BRANCHENFÜHRER", "branchenführer"],
      ["Messekatalog 2024.pdf", "MESSEKATALOG", "messekatalog"],
    ] as const;
    for (const [filename, text, type] of examples) {
      expect(deriveDocumentClassification({
        filename,
        pages: [{ pageNumber: 1, text }],
      }).type).toBe(type);
    }
  });

  it("erkennt unbekannte Kreise und Gemeinden über Namensmuster statt Listen", () => {
    const result = deriveDocumentClassification({
      filename: "Amtsblatt Landkreis Schaumburg.pdf",
      pages: [{
        pageNumber: 1,
        text: "AMTSBLATT LANDKREIS SCHAUMBURG\nNiedersachsen\nAusgabe 3/2024",
      }],
    });
    expect(result.regionDistrict).toBe("Landkreis Schaumburg");
    expect(result.regionState).toBe("Niedersachsen");
    expect(result.periodIssue).toBe(3);
    expect(result.periodStartYear).toBe(2024);
    expect(result.periodConfidence).toBeGreaterThan(0.8);

    const municipality = deriveDocumentClassification({
      filename: "Gemeinde Wusterhausen.pdf",
      pages: [{ pageNumber: 1, text: "Gemeinde Wusterhausen\nBrandenburg" }],
    });
    expect(municipality.regionPlace).toBe("Wusterhausen");
    expect(municipality.regionState).toBe("Brandenburg");

    const state = deriveDocumentClassification({
      filename: "Amtsblatt Sachsen-Anhalt.pdf",
      pages: [{ pageNumber: 1, text: "AMTSBLATT SACHSEN-ANHALT" }],
    });
    expect(state.regionState).toBe("Sachsen-Anhalt");

    const longDistrict = deriveDocumentClassification({
      filename: "Amtsblatt Landkreis Musterstadt.pdf",
      pages: [{
        pageNumber: 1,
        text: "Der Landkreis Musterstadt informiert seine Bürgerinnen und Bürger über neue Regelungen.",
      }],
    });
    expect(longDistrict.regionDistrict).toBe("Landkreis Musterstadt");
    const overlongDistrict = deriveDocumentClassification({
      filename: "Amtsblatt Landkreis.pdf",
      pages: [{ pageNumber: 1, text: `Landkreis ${"A".repeat(101)}` }],
    });
    expect(overlongDistrict.regionDistrict).toBeNull();

    for (const expected of [
      "Mecklenburg-Vorpommern",
      "Nordrhein-Westfalen",
      "Rheinland-Pfalz",
      "Schleswig-Holstein",
    ]) {
      expect(deriveDocumentClassification({
        filename: "Amtsblatt.pdf",
        pages: [{ pageNumber: 1, text: `Amtsblatt\n${expected}` }],
      }).regionState).toBe(expected);
    }
  });

  it("hält schwache und kontextlose Signale unsicher oder leer", () => {
    const result = deriveDocumentClassification({
      filename: "Informationen.pdf",
      pages: [{ pageNumber: 1, text: "Messezeiten und Gottesdienste\nStand: 2019" }],
    });
    expect(result.type).toBeNull();
    expect(result.periodStartYear).toBeNull();
    expect(result.periodConfidence).toBeNull();
  });

  it("bevorzugt PDF-Metadaten und typografische Titel vor beliebigen Deckblattzeilen", () => {
    const filenameFallback = deriveDocumentClassification({
      filename: "unbekanntes-dokument.pdf",
      pages: [{ pageNumber: 1, text: "" }],
    });
    expect(filenameFallback.publicationName).toBe("unbekanntes-dokument");
    expect(filenameFallback.publicationNameSource).toBe("filename");
    expect(filenameFallback.publicationNameConfidence).toBe(0.35);

    const metadata = deriveDocumentClassification({
      filename: "amtsblatt.pdf",
      pages: [{ pageNumber: 1, text: "Ausgabe 2026\nSlogan", titleCandidates: [
        { text: "Amtsblatt für den Landkreis Beispiel", size: 24 },
      ] }],
      pdfMetadata: { title: "Amtsblatt Ausgabe Nr. 1 vom 7. Januar 2026" },
    });
    expect(metadata.publicationName).toBe("Amtsblatt für den Landkreis Beispiel");
    expect(metadata.publicationNameSource).toBe("title-page");

    const typography = deriveDocumentClassification({
      filename: "messe.pdf",
      pages: [{ pageNumber: 1, text: "09.-10. September 2024", titleCandidates: [
        { text: "18. Kulturbörse für Straßenkunst", size: 26 },
        { text: "09.-10. September 2024", size: 15 },
      ] }],
    });
    expect(typography.publicationName).toBe("18. Kulturbörse für Straßenkunst");
  });

  it("verwirft Fließtext als Ortsnamen", () => {
    const result = deriveDocumentClassification({
      filename: "magazin.pdf",
      pages: [{ pageNumber: 1, text: "Stadt Zu Verlieben\nDas Magazin" }],
    });
    expect(result.regionPlace).toBeNull();
  });

  it("bewahrt manuelle Korrekturen bei einer erneuten Ableitung", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "wegweiser.pdf",
      sha256: "f".repeat(64),
      storageKey: "tenants/1/originals/f/wegweiser.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    await repository.upsertDerivedClassification("1", document.document.id, deriveDocumentClassification({
      filename: "wegweiser.pdf",
      pages: [{ pageNumber: 1, text: "SENIORENWEGWEISER HAMBURG 2020" }],
    }));
    await repository.updateClassificationManual("1", document.document.id, {
      type: "stadt-und-gemeindemagazin",
      regionState: "Schleswig-Holstein",
    }, "user-1");
    await repository.upsertDerivedClassification("1", document.document.id, deriveDocumentClassification({
      filename: "wegweiser.pdf",
      pages: [{ pageNumber: 1, text: "SENIORENWEGWEISER HAMBURG\nAusgabe 2021" }],
    }));
    const result = (await repository.getDocument("1", document.document.id)).classification;
    expect(result?.type).toBe("stadt-und-gemeindemagazin");
    expect(result?.typeSource).toBe("manual");
    expect(result?.regionState).toBe("Schleswig-Holstein");
    expect(result?.regionSource).toBe("manual");
    expect(result?.periodStartYear).toBe(2021);
  });

  it("wendet manuelle Korrekturen feldweise an und bewahrt absichtliches Leeren", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "wegweiser.pdf",
      sha256: "e".repeat(64),
      storageKey: "tenants/1/originals/e/wegweiser.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    await repository.upsertDerivedClassification("1", document.document.id, deriveDocumentClassification({
      filename: "wegweiser.pdf",
      pages: [{ pageNumber: 1, text: "SENIORENWEGWEISER HAMBURG\nAusgabe 2020" }],
    }));
    await repository.updateClassificationManual("1", document.document.id, {
      regionState: null,
    }, "user-1");
    await repository.upsertDerivedClassification("1", document.document.id, deriveDocumentClassification({
      filename: "wegweiser.pdf",
      pages: [{ pageNumber: 1, text: "BRANCHENFÜHRER BERLIN\nAusgabe 2021" }],
    }));
    await repository.updateClassificationManual("1", document.document.id, {
      publicationName: "Manueller Titel",
    }, "user-1");
    const result = (await repository.getDocument("1", document.document.id)).classification;
    expect(result?.regionState).toBeNull();
    expect(result?.regionSource).toBe("manual");
    expect(result?.publicationName).toBe("Manueller Titel");
    expect(result?.publicationNameSource).toBe("manual");
    expect(result?.type).toBe("branchenführer");
    expect(result?.typeSource).toBe("title-page");
    expect(result?.periodStartYear).toBe(2021);
  });

  it("validiert Korrekturjahre verständlich", () => {
    expect(() => classificationCorrectionSchema.parse({ id: 1, periodStartYear: 999 }))
      .toThrow("Das Jahr muss mindestens 1000 sein.");
    expect(() => classificationCorrectionSchema.parse({ id: 1, periodEndYear: 2201 }))
      .toThrow("Das Jahr darf höchstens 2200 sein.");
    expect(() => classificationCorrectionSchema.parse({ id: 1, periodStartYear: 2025, periodEndYear: 2024 }))
      .toThrow("Das Endjahr darf nicht vor dem Startjahr liegen.");
    expect(classificationCorrectionSchema.parse({ id: 1, periodStartYear: 2020, periodEndYear: 2021 }))
      .toMatchObject({ periodStartYear: 2020, periodEndYear: 2021 });
  });

  it("filtert Speicher-Dokumente nur innerhalb des vollständigen Zeitraums", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "zeitraum.pdf",
      sha256: "d".repeat(64),
      storageKey: "tenants/1/originals/d/zeitraum.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    await repository.upsertDerivedClassification("1", document.document.id, {
      type: null, typeSource: "first-pages", typeConfidence: null,
      publicationName: null, publicationNameSource: "first-pages", publicationNameConfidence: null,
      editionLabel: null, editionSource: "first-pages", editionConfidence: null,
      periodStartYear: 2020, periodEndYear: 2021, periodIssue: null,
      periodSource: "first-pages", periodConfidence: 0.5,
      regionPlace: null, regionDistrict: null, regionState: null,
      regionSource: "first-pages", regionConfidence: null,
    });
    expect((await repository.listDocuments("1", { periodYear: 2021 })).map((row) => row.id))
      .toContain(document.document.id);
    expect(await repository.listDocuments("1", { periodYear: 2022 })).toHaveLength(0);
  });

  it("dedupliziert Dokumente über den Inhalts-Hash", async () => {
    const repository = new MemoryIngestionRepository();
    const input = {
      filename: "a.pdf",
      sha256: "a".repeat(64),
      storageKey: "tenants/1/originals/a/a.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    };
    const first = await repository.createUploadedDocument("1", input);
    const second = await repository.createUploadedDocument("1", input);
    expect(second.document.id).toBe(first.document.id);
    expect(second.deduplicated).toBe(true);
    expect(repository.documents).toHaveLength(1);
    expect((await repository.createUploadedDocument("2", input)).deduplicated).toBe(false);
  });

  it("führt einen Dokumentzustand kontrolliert weiter", async () => {
    const repository = new MemoryIngestionRepository();
    const result = await repository.createUploadedDocument("1", {
      filename: "a.pdf",
      sha256: "b".repeat(64),
      storageKey: "tenants/1/originals/b/a.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const processing = await repository.setDocumentState("1", result.document.id, "processing");
    const updated = await repository.setDocumentState("1", result.document.id, "failed", "OCR fehlgeschlagen");
    expect(processing.state).toBe("processing");
    expect(updated.state).toBe("failed");
    expect(updated.error).toBe("OCR fehlgeschlagen");
  });

  it("publiziert eine Fundstelle trotz doppelter Zustellung nur einmal", async () => {
    const events = new MemoryEventRepository();
    const input = {
      name: "advertisement.detected",
      tenantId: "1",
      aggregateType: "occurrence",
      aggregateId: "1",
      payload: { occurrenceId: 1, documentId: 1 },
      idempotencyKey: "advertisement.detected:hash",
    } as const;
    await events.append({ ...input, id: "event-1", occurredAt: new Date() });
    await events.append({ ...input, id: "event-2", occurredAt: new Date() });
    expect(events.events).toHaveLength(1);
  });

  it("verarbeitet einen wiederholten Job ohne doppelte Fundstellen", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "a.pdf",
      sha256: "c".repeat(64),
      storageKey: "tenants/1/originals/c/a.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    let calls = 0;
    const publishedKeys: string[] = [];
    const module = createIngestionModule({
      repository,
      repositoryForTransaction: () => repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => {
        calls += 1;
        return [{
          pageNumber: 1,
          text: "Muster GmbH Werbung Telefon",
          imageKey: "page.png",
          classification: "MIXED_CONTENT",
          adProbability: 0.5,
          occurrences: [{
            bbox: { x: 0, y: 0, width: 1, height: 1 },
            imageKey: "ad.png",
            confidence: 0.8,
            company: "Muster GmbH",
            preview: "Muster GmbH Werbung Telefon",
          }],
        }];
      },
        publish: async (event) => {
          publishedKeys.push(event.idempotencyKey);
        },
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await job.handle(
      { documentId: document.document.id },
      context("1", { documentId: document.document.id }),
    );
    document.document.state = "uploaded";
    await job.handle(
      { documentId: document.document.id },
      context("1", { documentId: document.document.id }),
    );
    expect(calls).toBe(2);
    expect(repository.occurrences).toHaveLength(1);
    expect(publishedKeys).toHaveLength(2);
    expect(publishedKeys[0]).toBe(publishedKeys[1]);
  });

  it("bildet Fundstellen ohne Laufzeit-ID stabil und unterscheidet gleiche Firmen auf einer Seite", () => {
    const first = advertisementEventIdempotencyKey("1", "hash", {
      pageNumber: 4,
      company: "  Muster   GmbH ",
      preview: "Muster GmbH   Telefon",
      bbox: { x: 1.1111, y: 2, width: 3, height: 4 },
    });
    const retry = advertisementEventIdempotencyKey("1", "hash", {
      pageNumber: 4,
      company: "muster gmbh",
      preview: "Muster GmbH Telefon",
      bbox: { height: 4, width: 3, y: 2, x: 1.1112 },
    });
    const secondPlacement = advertisementEventIdempotencyKey("1", "hash", {
      pageNumber: 4,
      company: "Muster GmbH",
      preview: "Muster GmbH Telefon",
      bbox: { x: 20, y: 2, width: 3, height: 4 },
    });
    expect(first).toBe(retry);
    expect(secondPlacement).not.toBe(first);
  });

  it("setzt ein Dokument bei nicht erreichbarer Verarbeitung auf Fehler", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "a.pdf",
      sha256: "d".repeat(64),
      storageKey: "tenants/1/originals/d/a.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const module = createIngestionModule({
      repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => {
        throw new Error("PDF-Verarbeitung ist nicht erreichbar");
      },
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await expect(job.handle(
      { documentId: document.document.id },
      context("1", { documentId: document.document.id }),
    ))
      .rejects.toThrow("PDF-Verarbeitung ist nicht erreichbar");
  });

  it("verarbeitet ein Dokument des zweiten Mandanten mit dem Job-Mandanten", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("2", {
      filename: "tenant-2.pdf",
      sha256: "e".repeat(64),
      storageKey: "tenants/2/originals/e/tenant-2.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const module = createIngestionModule({
      repository,
      repositoryForTransaction: () => repository,
      transaction: async (callback) => callback({}),
      processDocument: async ({ tenantId }) => [{
        pageNumber: 1,
        text: `Mandant ${tenantId}`,
        imageKey: "page.png",
        classification: "MIXED_CONTENT",
        adProbability: 0.5,
        occurrences: [],
      }],
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await job.handle(
      { documentId: document.document.id },
      context("2", { documentId: document.document.id }),
    );
    expect((await repository.getDocument("2", document.document.id)).state).toBe("processed");
  });

  it("verweigert einen Job ohne ermittelbaren Mandanten", async () => {
    const repository = new MemoryIngestionRepository();
    const module = createIngestionModule({ repository, publish: async () => undefined });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await expect(job.handle(
      { documentId: 1 },
      context(null, { documentId: 1 }),
    )).rejects.toThrow("Mandant für Job fehlt");
  });

  it("markiert ein Dokument nach einem endgültigen Jobfehler als fehlgeschlagen", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("2", {
      filename: "tenant-2-failed.pdf",
      sha256: "f".repeat(64),
      storageKey: "tenants/2/originals/f/tenant-2-failed.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const module = createIngestionModule({
      repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => { throw new Error("PIF dauerhaft nicht erreichbar"); },
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job || !job.onFailure) throw new Error("Verarbeitungsjob fehlt");
    const failureContext = context("2", { documentId: document.document.id });
    await expect(job.handle({ documentId: document.document.id }, failureContext))
      .rejects.toThrow("PIF dauerhaft nicht erreichbar");
    await job.onFailure("PIF dauerhaft nicht erreichbar", failureContext);
    const failed = await repository.getDocument("2", document.document.id);
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("PIF dauerhaft nicht erreichbar");
  });

  it("markiert ein Dokument auch bei fehlendem Job-Mandanten als fehlgeschlagen", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("2", {
      filename: "unknown-tenant.pdf",
      sha256: "0".repeat(64),
      storageKey: "tenants/2/originals/0/unknown-tenant.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const module = createIngestionModule({
      repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => { throw new Error("Mandant für Job fehlt"); },
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job || !job.onFailure) throw new Error("Verarbeitungsjob fehlt");
    const failureContext = context(null, { documentId: document.document.id });
    await job.onFailure("Mandant für Job fehlt", failureContext);
    const failed = await repository.getDocument("2", document.document.id);
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("Mandant für Job fehlt");
  });
});
