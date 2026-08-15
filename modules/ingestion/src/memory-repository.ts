import type {
  IngestionDocument,
  IngestionOccurrence,
  IngestionRepository,
  IngestionSource,
  OccurrenceReviewResult,
} from "./repository.js";
import { occurrenceFingerprint } from "./repository.js";
import type { DerivedClassification, DocumentClassification } from "./classification.js";
import { IngestionSourceNotFoundError, periodIncludesYear, type DocumentListFilters } from "./repository.js";

export class MemoryIngestionRepository implements IngestionRepository {
  sources: IngestionSource[] = [];
  documents: IngestionDocument[] = [];
  occurrences: IngestionOccurrence[] = [];
  classifications = new Map<string, DocumentClassification>();
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
    if (!source) throw new IngestionSourceNotFoundError();
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
  async listDocuments(tenantId: string, filters: DocumentListFilters = {}) {
    return this.documents.filter((document) => {
      if (document.tenantId !== tenantId) return false;
      const value = this.classifications.get(`${tenantId}:${document.id}`);
      if (filters.type && value?.type !== filters.type) return false;
      if (filters.regionState && value?.regionState !== filters.regionState) return false;
      if (filters.regionDistrict && value?.regionDistrict !== filters.regionDistrict) return false;
      if (filters.periodYear != null
        && !periodIncludesYear(value?.periodStartYear, value?.periodEndYear, filters.periodYear)) return false;
      return true;
    }).map((document) => ({
      ...document,
      classification: this.classifications.get(`${tenantId}:${document.id}`) ?? null,
    }));
  }
  async upsertDerivedClassification(tenantId: string, documentId: number, value: DerivedClassification) {
    const key = `${tenantId}:${documentId}`;
    const existing = this.classifications.get(key);
    const next: DocumentClassification = existing ?? {
      type: null, typeSource: "first-pages", typeConfidence: null,
      publicationName: null, publicationNameSource: "first-pages", publicationNameConfidence: null,
      editionLabel: null, editionSource: "first-pages", editionConfidence: null,
      periodStartYear: null, periodEndYear: null, periodIssue: null, periodSource: "first-pages", periodConfidence: null,
      regionPlace: null, regionDistrict: null, regionState: null, regionSource: "first-pages", regionConfidence: null,
      derivedAt: null, correctedAt: null, correctedBy: null,
    };
    if (next.typeSource !== "manual") Object.assign(next, { type: value.type, typeConfidence: value.typeConfidence, typeSource: value.typeSource });
    if (next.publicationNameSource !== "manual") Object.assign(next, { publicationName: value.publicationName, publicationNameConfidence: value.publicationNameConfidence, publicationNameSource: value.publicationNameSource });
    if (next.editionSource !== "manual") Object.assign(next, { editionLabel: value.editionLabel, editionConfidence: value.editionConfidence, editionSource: value.editionSource });
    if (next.periodSource !== "manual") Object.assign(next, {
      periodStartYear: value.periodStartYear, periodEndYear: value.periodEndYear,
      periodIssue: value.periodIssue, periodConfidence: value.periodConfidence, periodSource: value.periodSource,
    });
    if (next.regionSource !== "manual") Object.assign(next, {
      regionPlace: value.regionPlace, regionDistrict: value.regionDistrict,
      regionState: value.regionState, regionConfidence: value.regionConfidence, regionSource: value.regionSource,
    });
    next.derivedAt = new Date();
    this.classifications.set(key, next);
    return next;
  }
  async updateClassificationManual(tenantId: string, documentId: number, value: Partial<DerivedClassification>, actor: string) {
    const current = this.classifications.get(`${tenantId}:${documentId}`);
    if (!current) throw new Error("Dokumenteinordnung ist noch nicht vorhanden");
    if (Object.keys(value).length === 0) throw new Error("Keine Änderung vorgenommen.");
    if (value.type !== undefined) Object.assign(current, { type: value.type, typeSource: "manual" });
    if (value.publicationName !== undefined) Object.assign(current, { publicationName: value.publicationName, publicationNameSource: "manual" });
    if (value.editionLabel !== undefined) Object.assign(current, { editionLabel: value.editionLabel, editionSource: "manual" });
    if (value.periodStartYear !== undefined || value.periodEndYear !== undefined || value.periodIssue !== undefined) {
      Object.assign(current, {
        ...(value.periodStartYear !== undefined ? { periodStartYear: value.periodStartYear } : {}),
        ...(value.periodEndYear !== undefined ? { periodEndYear: value.periodEndYear } : {}),
        ...(value.periodIssue !== undefined ? { periodIssue: value.periodIssue } : {}),
        periodSource: "manual",
      });
    }
    if (value.regionPlace !== undefined || value.regionDistrict !== undefined || value.regionState !== undefined) {
      Object.assign(current, {
        ...(value.regionPlace !== undefined ? { regionPlace: value.regionPlace } : {}),
        ...(value.regionDistrict !== undefined ? { regionDistrict: value.regionDistrict } : {}),
        ...(value.regionState !== undefined ? { regionState: value.regionState } : {}),
        regionSource: "manual",
      });
    }
    current.correctedAt = new Date();
    current.correctedBy = actor;
    return current;
  }
  async listOccurrences(tenantId: string) {
    const documents = new Set((await this.listDocuments(tenantId)).map((document) => document.id));
    return this.occurrences.filter((occurrence) => documents.has(occurrence.documentId));
  }
  async getOccurrence(tenantId: string, occurrenceId: number) {
    const occurrence = this.occurrences.find((item) =>
      item.id === occurrenceId
      && this.documents.some((document) =>
        document.id === item.documentId && document.tenantId === tenantId,
      ));
    if (!occurrence) throw new Error("Fundstelle nicht gefunden");
    return occurrence;
  }
  async reviewOccurrence(tenantId: string, occurrenceId: number, status: "approved" | "rejected"): Promise<OccurrenceReviewResult> {
    const occurrence = await this.getOccurrence(tenantId, occurrenceId);
    if (occurrence.status === status) return { occurrence, changed: false };
    occurrence.status = status;
    return { occurrence, changed: true };
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
      classification: null,
    };
    this.documents.push(document);
    return { document, deduplicated: false };
  }
  async getDocument(tenantId: string, documentId: number) {
    const document = this.documents.find((item) => item.tenantId === tenantId && item.id === documentId);
    if (!document) throw new Error("Dokument nicht gefunden");
    document.classification = this.classifications.get(`${tenantId}:${documentId}`) ?? null;
    return document;
  }
  async getDocumentById(documentId: number) {
    const document = this.documents.find((item) => item.id === documentId);
    if (!document) throw new Error("Dokument nicht gefunden");
    document.classification = this.classifications.get(`${document.tenantId}:${documentId}`) ?? null;
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
      evidence: string[];
      company: string;
      preview: string;
    }>;
  }>) {
    const document = await this.getDocument(tenantId, documentId);
    const previous = this.occurrences.filter((item) => item.documentId === document.id);
    this.occurrences = this.occurrences.filter((item) => item.documentId !== document.id);
    const created = processedPages.flatMap((page) => page.occurrences.map((item) => {
      const fingerprint = occurrenceFingerprint({
        pageNumber: page.pageNumber,
        company: item.company,
        preview: item.preview,
        bbox: item.bbox,
      });
      const old = previous.find((candidate) =>
        occurrenceFingerprint(candidate) === fingerprint,
      );
      return {
      id: ++this.occurrenceId,
      documentId: document.id,
      pageNumber: page.pageNumber,
      company: item.company,
      preview: item.preview,
      status: old?.status ?? "detected",
      bbox: item.bbox,
      imageKey: item.imageKey,
      confidence: item.confidence,
      evidence: item.evidence ?? [],
    };
    }));
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
    const document = await this.getDocument(tenantId, documentId);
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
