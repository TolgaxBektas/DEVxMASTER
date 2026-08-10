export type IngestionSource = {
  id: number;
  tenantId: string;
  url: string;
  status: string;
  score: number;
  metadata: Record<string, unknown> | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  lastFetchedAt: Date | null;
  lastError: string | null;
};
export type IngestionDocument = {
  id: number;
  tenantId: string;
  sourceId: number | null;
  filename: string;
  sha256: string;
  storageKey: string;
  sizeBytes: number;
  mimeType: string;
  origin: string;
  state: string;
  error: string | null;
};
export type IngestionOccurrence = {
  id: number;
  documentId: number;
  company: string;
  preview: string;
  status: string;
  imageKey?: string | null;
  confidence?: number | null;
  bbox?: Record<string, number> | null;
};
export type IngestionRepository = {
  listSources(tenantId: string): Promise<IngestionSource[]>;
  createSource(tenantId: string, input: { url: string; score: number; metadata: Record<string, unknown> }): Promise<IngestionSource>;
  getSource(tenantId: string, sourceId: number): Promise<IngestionSource>;
  updateSource(tenantId: string, sourceId: number, input: {
    status?: string;
    approvedBy?: string | null;
    approvedAt?: Date | null;
    lastFetchedAt?: Date | null;
    lastError?: string | null;
  }): Promise<IngestionSource>;
  listDocuments(tenantId: string): Promise<IngestionDocument[]>;
  listOccurrences(tenantId: string): Promise<IngestionOccurrence[]>;
  createUploadedDocument(
    tenantId: string,
    input: {
      filename: string;
      sourceId?: number | null;
      sha256: string;
      storageKey: string;
      sizeBytes: number;
      mimeType: string;
      origin: string;
    },
  ): Promise<{ document: IngestionDocument; deduplicated: boolean }>;
  getDocument(tenantId: string, documentId: number): Promise<IngestionDocument>;
  getDocumentById(documentId: number): Promise<IngestionDocument>;
  replaceProcessedDocument(
    tenantId: string,
    documentId: number,
    pages: Array<{
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
    }>,
  ): Promise<IngestionOccurrence[]>;
  setDocumentState(
    tenantId: string,
    documentId: number,
    state: string,
    error?: string | null,
  ): Promise<IngestionDocument>;
};
