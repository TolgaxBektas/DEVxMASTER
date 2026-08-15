import type { DerivedClassification, DocumentClassification } from "./classification.js";

export class IngestionSourceNotFoundError extends Error {
  constructor() {
    super("Quelle nicht gefunden");
    this.name = "IngestionSourceNotFoundError";
  }
}

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
  classification: DocumentClassification | null;
};
export type DocumentListFilters = {
  type?: string;
  regionState?: string;
  regionDistrict?: string;
  periodYear?: number;
};

export function periodIncludesYear(
  periodStartYear: number | null | undefined,
  periodEndYear: number | null | undefined,
  year: number,
): boolean {
  return periodStartYear != null && periodEndYear != null
    && year >= periodStartYear
    && year <= periodEndYear;
}
export type IngestionOccurrence = {
  id: number;
  documentId: number;
  pageNumber?: number;
  company: string;
  preview: string;
  status: string;
  imageKey?: string | null;
  confidence?: number | null;
  bbox?: Record<string, number> | null;
  evidence?: string[] | null;
};
export type OccurrenceReviewResult = {
  occurrence: IngestionOccurrence;
  changed: boolean;
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
  listDocuments(tenantId: string, filters?: DocumentListFilters): Promise<IngestionDocument[]>;
  upsertDerivedClassification(
    tenantId: string,
    documentId: number,
    value: DerivedClassification,
  ): Promise<DocumentClassification>;
  updateClassificationManual(
    tenantId: string,
    documentId: number,
    value: Partial<DerivedClassification>,
    actor: string,
  ): Promise<DocumentClassification>;
  listOccurrences(tenantId: string): Promise<IngestionOccurrence[]>;
  getOccurrence(tenantId: string, occurrenceId: number): Promise<IngestionOccurrence>;
  reviewOccurrence(
    tenantId: string,
    occurrenceId: number,
    status: "approved" | "rejected",
  ): Promise<OccurrenceReviewResult>;
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
        evidence?: string[];
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
