import { describe, expect, it, vi } from "vitest";
import { MemoryAuditRepository } from "@xmaster-center/kernel";
import type { Storage } from "@xmaster-center/integrations";
import { MemoryIngestionRepository } from "./memory-repository.js";
import { createIngestionModule } from "./module.js";
import type {
  ArtworkHandoffManifest,
  ArtworkHandoffResult,
} from "./artwork-handoff-client.js";

const context = (tenantId: string, payload: unknown = {}) => ({
  job: { tenantId, payload },
});

function storage(bytes = new Uint8Array([1, 2, 3])) {
  return {
    get: vi.fn(async () => bytes),
  } as unknown as Storage;
}

async function occurrenceWithEvidence(
  repository: MemoryIngestionRepository,
  evidence: string[],
) {
  const area = await repository.upsertArea("1", {
    level: "district",
    ags: "09162",
    name: "Musterkreis",
    stateName: "Bayern",
    kind: "Landkreis",
    orderIndex: 1,
    status: "done",
    lastRunAt: null,
    startedAt: null,
    nextDueAt: null,
    lastError: null,
    foundSources: 1,
  });
  const source = await repository.createSource("1", {
    url: "https://example.test/amtsblatt.pdf",
    score: 1,
    metadata: {},
    areaId: area.id,
  });
  const document = await repository.createUploadedDocument("1", {
    filename: "amtsblatt.pdf",
    sourceId: source.id,
    sha256: "a".repeat(64),
    storageKey: "tenants/1/originals/a/amtsblatt.pdf",
    sizeBytes: 10,
    mimeType: "application/pdf",
    origin: "source",
  });
  await repository.upsertDerivedClassification("1", document.document.id, {
    type: "kommunales-amtsblatt",
    typeSource: "first-pages",
    typeConfidence: 0.9,
    publicationName: "Musterblatt",
    publicationNameSource: "first-pages",
    publicationNameConfidence: 0.9,
    editionLabel: "Ausgabe 4",
    editionSource: "first-pages",
    editionConfidence: 0.9,
    periodStartYear: 2026,
    periodEndYear: 2026,
    periodIssue: 4,
    periodSource: "first-pages",
    periodConfidence: 0.9,
    regionPlace: "Musterkreis",
    regionDistrict: "Musterkreis",
    regionState: "Bayern",
    regionSource: "first-pages",
    regionConfidence: 0.9,
  });
  const [occurrence] = await repository.replaceProcessedDocument(
    "1",
    document.document.id,
    [{
      pageNumber: 4,
      text: "Anzeige",
      imageKey: "tenants/1/processed/a/ad.png",
      classification: "MIXED_CONTENT",
      adProbability: 0.9,
      occurrences: [{
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        imageKey: "tenants/1/processed/a/ad.png",
        confidence: 0.95,
        evidence,
        company: "Muster GmbH",
        preview: "Muster GmbH · Telefon",
      }],
    }],
  );
  if (!occurrence) throw new Error("Fundstelle fehlt");
  return { document, occurrence };
}

describe("Übergabe frischer Fundstellen", () => {
  it("übergibt den vollständigen Herkunftssatz an den Bearbeitungsdienst", async () => {
    const repository = new MemoryIngestionRepository();
    const audit = new MemoryAuditRepository();
    const { occurrence } = await occurrenceWithEvidence(repository, [
      "geometry",
      "positiv:p2",
      "positiv:p3",
    ]);
    type HandoffInput = {
      original: Uint8Array;
      manifest: ArtworkHandoffManifest;
    };
    const handoff = vi.fn(async (_input: HandoffInput): Promise<ArtworkHandoffResult> => ({
      documentId: 11,
      adId: 22,
      reviewStatus: "pending",
      deduplicated: false,
    }));
    const module = createIngestionModule({
      repository,
      storage: storage(),
      audit,
      handoffToArtwork: handoff,
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.handoff.artwork");
    if (!job) throw new Error("Übergabejob fehlt");

    await job.handle({ occurrenceId: occurrence.id }, context("1"));

    expect(handoff).toHaveBeenCalledOnce();
    const input = handoff.mock.calls[0]?.[0];
    expect(input?.original).toEqual(new Uint8Array([1, 2, 3]));
    expect(input?.manifest).toMatchObject({
      company_name: "Muster GmbH",
      preview: "Muster GmbH · Telefon",
      confidence: 0.95,
      advertiser_proof: ["positiv:p2", "positiv:p3"],
      evidence: ["geometry", "positiv:p2", "positiv:p3"],
      provenance: {
        data_source: "xdata_germany",
        center_tenant_id: 1,
        center_occurrence_id: occurrence.id,
        document_sha256: "a".repeat(64),
        document_filename: "1:amtsblatt.pdf",
        source_url: "https://example.test/amtsblatt.pdf",
        area_name: "Musterkreis",
        area_ags: "09162",
        area_state: "Bayern",
        publication: "Musterblatt",
        edition: "Ausgabe 4",
        year: 2026,
        issue: 4,
        page: 4,
        bbox: [0.1, 0.2, 0.3, 0.4],
      },
    });
    expect(audit.entries).toHaveLength(1);
    expect(JSON.parse(audit.entries[0]?.detailsJson ?? "{}")).toEqual({
      artworkDocumentId: 11,
      artworkAdId: 22,
      reviewStatus: "pending",
      deduplicated: false,
    });
  });

  it("überspringt Altfunde ohne Inserenten-Nachweis mit Audit-Vermerk", async () => {
    const repository = new MemoryIngestionRepository();
    const audit = new MemoryAuditRepository();
    const { occurrence } = await occurrenceWithEvidence(repository, ["geometry"]);
    const handoff = vi.fn();
    const module = createIngestionModule({
      repository,
      storage: storage(),
      audit,
      handoffToArtwork: handoff,
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.handoff.artwork");
    if (!job) throw new Error("Übergabejob fehlt");

    await job.handle({ occurrenceId: occurrence.id }, context("1"));

    expect(handoff).not.toHaveBeenCalled();
    expect(JSON.parse(audit.entries[0]?.detailsJson ?? "{}")).toMatchObject({
      skipped: true,
      reason: "Kein Inserenten-Nachweis",
    });
  });

  it("meldet einen fehlenden Bearbeitungsdienst verständlich", async () => {
    const repository = new MemoryIngestionRepository();
    const { occurrence } = await occurrenceWithEvidence(repository, ["positiv:p2"]);
    const module = createIngestionModule({
      repository,
      storage: storage(),
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.handoff.artwork");
    if (!job) throw new Error("Übergabejob fehlt");

    await expect(job.handle({ occurrenceId: occurrence.id }, context("1")))
      .rejects.toThrow("Bearbeitungsdienst ist nicht eingerichtet");
  });

  it("meldet einen fehlenden Ausschnitt verständlich", async () => {
    const repository = new MemoryIngestionRepository();
    const { occurrence } = await occurrenceWithEvidence(repository, ["positiv:p2"]);
    const provenance = repository.getOccurrenceProvenance.bind(repository);
    repository.getOccurrenceProvenance = async (tenantId, occurrenceId) => ({
      ...await provenance(tenantId, occurrenceId),
      imageKey: null,
    });
    const module = createIngestionModule({
      repository,
      storage: storage(),
      handoffToArtwork: async () => ({
        documentId: 1,
        adId: 1,
        reviewStatus: "pending",
        deduplicated: false,
      }),
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.handoff.artwork");
    if (!job) throw new Error("Übergabejob fehlt");

    await expect(job.handle({ occurrenceId: occurrence.id }, context("1")))
      .rejects.toThrow("Ausschnitt fehlt, Übergabe nicht möglich");
  });

  it("meldet eine fehlende Seitenzahl verständlich", async () => {
    const repository = new MemoryIngestionRepository();
    const { occurrence } = await occurrenceWithEvidence(repository, ["positiv:p2"]);
    const provenance = repository.getOccurrenceProvenance.bind(repository);
    repository.getOccurrenceProvenance = async (tenantId, occurrenceId) => ({
      ...await provenance(tenantId, occurrenceId),
      page: { id: 1, number: null },
    });
    const module = createIngestionModule({
      repository,
      storage: storage(),
      handoffToArtwork: async () => ({
        documentId: 1,
        adId: 1,
        reviewStatus: "pending",
        deduplicated: false,
      }),
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.handoff.artwork");
    if (!job) throw new Error("Übergabejob fehlt");

    await expect(job.handle({ occurrenceId: occurrence.id }, context("1")))
      .rejects.toThrow("Seitenzahl fehlt, Übergabe nicht möglich");
  });

  it("reiht nach der Verarbeitung nur nachgewiesene Fundstellen ein", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "verarbeitung.pdf",
      sha256: "b".repeat(64),
      storageKey: "tenants/1/originals/b/verarbeitung.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const enqueued: unknown[] = [];
    const module = createIngestionModule({
      repository,
      repositoryForTransaction: () => repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => [{
        pageNumber: 1,
        text: "Anzeigen",
        imageKey: "page.png",
        classification: "MIXED_CONTENT",
        adProbability: 0.9,
        occurrences: [
          {
        bbox: { x: 0, y: 0, width: 1, height: 1, confidence: 0.9 },
            imageKey: "positive.png",
            confidence: 0.9,
            evidence: ["geometry", "positiv:p2"],
            company: "Nachgewiesen GmbH",
            preview: "Nachgewiesen",
          },
          {
            bbox: { x: 0, y: 0, width: 1, height: 1, confidence: 0.9 },
            imageKey: "legacy.png",
            confidence: 0.9,
            evidence: ["geometry"],
            company: "Altbestand GmbH",
            preview: "Altbestand",
          },
        ],
      }],
      enqueue: async (input) => {
        enqueued.push(input);
      },
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");

    await job.handle({ documentId: document.document.id }, context("1", {
      documentId: document.document.id,
    }));

    expect(enqueued).toEqual([{
      name: "ingestion.handoff.artwork",
      tenantId: "1",
      payload: { occurrenceId: 1 },
    }]);
  });
});
