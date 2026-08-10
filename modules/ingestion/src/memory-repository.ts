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
    const ids = new Set((await this.listSources(tenantId)).map((source) => source.id));
    return this.documents.filter((document) => !document.sourceId || ids.has(document.sourceId));
  }
  async listOccurrences(tenantId: string) {
    const documents = new Set((await this.listDocuments(tenantId)).map((document) => document.id));
    return this.occurrences.filter((occurrence) => documents.has(occurrence.documentId));
  }
  async ingestDemo(tenantId: string) {
    const source = { id: ++this.sourceId, url: `${tenantId}:demo://publication`, status: "discovered" };
    const document = {
      id: ++this.documentId,
      sourceId: source.id,
      filename: "demo-publication.pdf",
      sha256: `demo-${tenantId}-${this.documentId}`,
      state: "processed",
      error: null,
    };
    const occurrence = {
      id: ++this.occurrenceId,
      documentId: document.id,
      company: "Beispiel GmbH",
      preview: "Beispiel GmbH · Werbung · 01234 567890",
      status: "detected",
    };
    this.sources.push(source);
    this.documents.push(document);
    this.occurrences.push(occurrence);
    return { source, document, occurrence };
  }
}
