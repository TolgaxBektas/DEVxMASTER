import { describe, expect, it } from "vitest";
import { MemoryEventRepository } from "@xmaster-center/kernel";
import { MemoryIngestionRepository } from "./memory-repository.js";

describe("Ingestion-Bestand", () => {
  it("dedupliziert Dokumente über den Inhalts-Hash", async () => {
    const repository = new MemoryIngestionRepository();
    const first = await repository.ingestDemo("1");
    const second = await repository.ingestDemo("1");
    expect(second.document.id).toBe(first.document.id);
    expect(repository.documents).toHaveLength(1);
    expect(repository.occurrences).toHaveLength(1);
  });

  it("führt einen Dokumentzustand kontrolliert weiter", async () => {
    const repository = new MemoryIngestionRepository();
    const result = await repository.ingestDemo("1");
    result.document.state = "discovered";
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
});
