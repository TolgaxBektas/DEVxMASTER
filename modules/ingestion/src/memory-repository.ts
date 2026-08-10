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
    return this.sources.filter((source) => source.tenantId === tenantId);
  }
  async createSource(tenantId: string, input: { url: string; score: number; metadata: Record<string, unknown> }) {
    const existing = this.sources.find((source) => source.tenantId === tenantId && source.url === input.url);
    if (existing) return existing;
    const source = {
      id: ++this.sourceId,
      tenantId,
      url: input.url,
      status: "proposed",
      score: input.score,
      metadata: input.metadata,
      approvedBy: null,
      approvedAt: null,
      lastFetchedAt: null,
      lastError: null,
    };
    this.sources.push(source);
    return source;
  }
  async getSource(tenantId: string, sourceId: number) {
    const source = this.sources.find((item) => item.tenantId === tenantId && item.id === sourceId);
    if (!source) throw new Error("Quelle nicht gefunden");
    return source;
  }
  async updateSource(tenantId: string, sourceId: number, input: {
    status?: string; approvedBy?: string | null; approvedAt?: Date | null;
    lastFetchedAt?: Date | null; lastError?: string | null;
  }) {
    const source = await this.getSource(tenantId, sourceId);
    Object.assign(source, input);
    return source;
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
    sourceId?: number | null;
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
      sourceId: input.sourceId ?? null,
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
  async getDocumentById(documentId: number) {
    const document = this.documents.find((item) => item.id === documentId);
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
