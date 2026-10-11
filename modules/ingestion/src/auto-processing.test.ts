import { describe, expect, it, vi } from "vitest";
import { MemoryAuditRepository } from "@xmaster-center/kernel";
import { NoopStorage } from "@xmaster-center/integrations";
import { createIngestionModule } from "./module.js";
import { MemoryIngestionRepository } from "./memory-repository.js";

const context = (payload: unknown) => ({
  job: { tenantId: "1", payload },
  signal: new AbortController().signal,
  lockLease: async () => true,
});

describe("automatische PDF-Verarbeitung", () => {
  it.each([true, false])(
    "speichert abgerufene Dokumente und steuert den Verarbeitungsjob über INGESTION_AUTO_PROCESS=%s",
    async (autoProcess) => {
      const repository = new MemoryIngestionRepository();
      const source = await repository.createSource("1", {
        url: "https://example.invalid/heft.pdf",
        score: 80,
        metadata: {},
      });
      await repository.updateSource("1", source.id, { status: "approved" });
      const enqueued: Array<{ name: string; payload: unknown }> = [];
      const module = createIngestionModule({
        repository,
        audit: new MemoryAuditRepository(),
        storage: new NoopStorage(),
        autoProcess,
        transaction: async (callback) => callback({}),
        repositoryForTransaction: () => repository,
        fetchSource: async () => ({
          bytes: Buffer.from("%PDF-1.7\nfixture"),
          filename: "heft.pdf",
        }),
        enqueue: async (input) => {
          enqueued.push(input);
        },
        publish: async () => undefined,
      });
      const job = module.jobs.find((item) => item.name === "ingestion.source.fetch");
      if (!job) throw new Error("Quellenabrufjob fehlt");

      await job.handle({ sourceId: source.id }, context({ sourceId: source.id }));

      expect(repository.documents).toHaveLength(1);
      expect(await repository.getDocument("1", repository.documents[0]!.id)).toMatchObject({
        sourceId: source.id,
        state: "uploaded",
        origin: "source",
      });
      expect(enqueued).toEqual(autoProcess
        ? [{
            name: "ingestion.processing.run",
            tenantId: "1",
            payload: { documentId: repository.documents[0]!.id },
          }]
        : []);
    },
  );

  it("überspringt den automatischen Sammellauf, verarbeitet aber gezielte Jobs weiter", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "heft.pdf",
      sha256: "a".repeat(64),
      storageKey: "heft.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const listDocuments = vi.spyOn(repository, "listDocuments");
    const processDocument = vi.fn(async () => [{
      pageNumber: 1,
      text: "Inhalt",
      imageKey: null,
      classification: "EDITORIAL_ONLY",
      adProbability: 0,
      occurrences: [],
    }]);
    const module = createIngestionModule({
      repository,
      autoProcess: false,
      transaction: async (callback) => callback({}),
      repositoryForTransaction: () => repository,
      processDocument,
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");

    await job.handle({}, context({}));

    expect(listDocuments).not.toHaveBeenCalled();
    expect(processDocument).not.toHaveBeenCalled();
    expect((await repository.getDocument("1", document.document.id)).state).toBe("uploaded");

    await job.handle(
      { documentId: document.document.id },
      context({ documentId: document.document.id }),
    );

    expect(processDocument).toHaveBeenCalledOnce();
    expect((await repository.getDocument("1", document.document.id)).state).toBe("processed");
  });
});
