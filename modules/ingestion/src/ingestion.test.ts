import { describe, expect, it } from "vitest";
import { MemoryEventRepository } from "@xmaster-center/kernel";
import { MemoryIngestionRepository } from "./memory-repository.js";
import { createIngestionModule } from "./module.js";

describe("Ingestion-Bestand", () => {
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
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await job.handle({ tenantId: "1", documentId: document.document.id }, {});
    await job.handle({ tenantId: "1", documentId: document.document.id }, {});
    expect(calls).toBe(1);
    expect(repository.occurrences).toHaveLength(1);
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
    await expect(job.handle({ tenantId: "1", documentId: document.document.id }, {}))
      .rejects.toThrow("PDF-Verarbeitung ist nicht erreichbar");
  });
});
