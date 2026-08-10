export type IngestionSource = { id: number; url: string; status: string };
export type IngestionDocument = {
  id: number;
  sourceId: number | null;
  filename: string;
  sha256: string;
  state: string;
  error: string | null;
};
export type IngestionOccurrence = {
  id: number;
  documentId: number;
  company: string;
  preview: string;
  status: string;
};
export type IngestionRepository = {
  listSources(tenantId: string): Promise<IngestionSource[]>;
  listDocuments(tenantId: string): Promise<IngestionDocument[]>;
  listOccurrences(tenantId: string): Promise<IngestionOccurrence[]>;
  ingestDemo(tenantId: string): Promise<{
    source: IngestionSource;
    document: IngestionDocument;
    occurrence: IngestionOccurrence;
  }>;
};
