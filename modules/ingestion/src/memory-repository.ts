import type {
  IngestionDocument,
  IngestionOccurrence,
  IngestionRepository,
  IngestionSource,
} from "./repository.js";

export class MemoryIngestionRepository implements IngestionRepository {
  sources: IngestionSource[] = [];
  documents: IngestionDocument[] = [];
  occurrences: IngestionOccurrence[] = [];
  private sourceId = 0;
  private documentId = 0;
  private occurrenceId = 0;

  async listSources(tenantId: string) {
    return this.sources.filter((source) => source.url.startsWith(`${tenantId}:`));
  }
  async listDocuments(tenantId: string) {
    return this.documents.filter((document) => document.tenantId === tenantId);
  }
  async listOccurrences(tenantId: string) {
    const documents = new Set((await this.listDocuments(tenantId)).map((document) => document.id));
    return this.occurrences.filter((occurrence) => documents.has(occurrence.documentId));
  }
  async createUploadedDocument(tenantId: string, input: {
    filename: string;
    sha256: string;
    storageKey: string;
    sizeBytes: number;
    mimeType: string;
    origin: string;
  }) {
    const existing = this.documents.find(
      (item) => item.sha256 === input.sha256 && item.tenantId === tenantId,
    );
    if (existing) return { document: existing, deduplicated: true };
    const document = {
      id: ++this.documentId,
      tenantId,
      sourceId: null,
      filename: `${tenantId}:${input.filename}`,
      sha256: input.sha256,
      storageKey: input.storageKey,
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
      origin: input.origin,
      state: "uploaded",
      error: null,
    };
    this.documents.push(document);
    return { document, deduplicated: false };
  }
  async getDocument(tenantId: string, documentId: number) {
    const document = (await this.listDocuments(tenantId)).find((item) => item.id === documentId);
    if (!document) throw new Error("Dokument nicht gefunden");
    return document;
  }
  async replaceProcessedDocument(tenantId: string, documentId: number, processedPages: Array<{
    pageNumber: number;
    text: string;
    imageKey: string;
    classification: string;
    adProbability: number;
    occurrences: Array<{
      bbox: Record<string, number>;
      imageKey: string;
      confidence: number;
      company: string;
      preview: string;
    }>;
  }>) {
    const document = await this.getDocument(tenantId, documentId);
    this.occurrences = this.occurrences.filter((item) => item.documentId !== document.id);
    const created = processedPages.flatMap((page) => page.occurrences.map((item) => ({
      id: ++this.occurrenceId,
      documentId: document.id,
      company: item.company,
      preview: item.preview,
      status: "detected",
    })));
    this.occurrences.push(...created);
    document.state = "processed";
    document.error = null;
    return created;
  }

  async setDocumentState(
    tenantId: string,
    documentId: number,
    state: string,
    error: string | null = null,
  ) {
    const document = (await this.listDocuments(tenantId)).find((item) => item.id === documentId);
    if (!document) throw new Error("Dokument nicht gefunden");
    const allowed: Record<string, string[]> = {
      uploaded: ["processing", "failed"],
      discovered: ["processing", "failed"],
      processing: ["processed", "failed"],
      failed: ["processing"],
      processed: [],
    };
    if (!allowed[document.state]?.includes(state))
      throw new Error(`Ungültiger Dokumentzustand: ${document.state} -> ${state}`);
    document.state = state;
    document.error = error;
    return { ...document };
  }
}
