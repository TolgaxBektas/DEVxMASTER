import type {
  IngestionDocument,
  IngestionOccurrence,
  IngestionRepository,
  IngestionSource,
  IngestionArea,
  IngestionSourceVisit,
  OccurrenceReviewResult,
} from "./repository.js";
import type { DerivedClassification, DocumentClassification } from "./classification.js";
import {
  IngestionSourceNotFoundError,
  occurrenceFingerprint,
  periodIncludesYear,
  type DocumentListFilters,
} from "./repository.js";
import { documentActualityStatus, sourceActualityHint, type ActualityStatus } from "./actuality.js";

export class MemoryIngestionRepository implements IngestionRepository {
  sources: IngestionSource[] = [];
  documents: IngestionDocument[] = [];
  occurrences: IngestionOccurrence[] = [];
  classifications = new Map<string, DocumentClassification>();
  private sourceId = 0;
  private documentId = 0;
  private occurrenceId = 0;
  areas: IngestionArea[] = [];
  sourceVisits: IngestionSourceVisit[] = [];
  private areaId = 0;
  private visitId = 0;

  async listSources(tenantId: string) {
    return this.sources.filter((source) => source.tenantId === tenantId).map((source) => ({
      ...source,
      lastCheckedAt: this.sourceVisits.filter((visit) => visit.tenantId === tenantId && visit.sourceId === source.id)
        .sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime())[0]?.checkedAt ?? null,
      actualityHint: sourceActualityHint(source.metadata),
    }));
  }
  async createSource(tenantId: string, input: { url: string; score: number; metadata: Record<string, unknown>; areaId?: number | null; revisitIntervalDays?: number; nextCheckAt?: Date | null }) {
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
      areaId: input.areaId ?? null,
      revisitIntervalDays: input.revisitIntervalDays ?? 90,
      nextCheckAt: input.nextCheckAt ?? null,
      productive: false,
      fingerprint: null,
      revisitFailures: 0,
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
    areaId?: number | null; revisitIntervalDays?: number; nextCheckAt?: Date | null;
    productive?: boolean; fingerprint?: string | null;
    revisitFailures?: number;
  }) {
    const source = await this.getSource(tenantId, sourceId);
    Object.assign(source, input);
    return source;
  }
  async listAreas(tenantId: string) {
    return this.areas.filter((area) => area.tenantId === tenantId).sort((a, b) => a.orderIndex - b.orderIndex);
  }
  async upsertArea(tenantId: string, input: Omit<IngestionArea, "id" | "tenantId" | "createdAt">) {
    const existing = this.areas.find((a) => a.tenantId === tenantId && a.ags === input.ags);
    if (existing) { Object.assign(existing, input); return existing; }
    const area = { ...input, id: ++this.areaId, tenantId, createdAt: new Date() };
    this.areas.push(area);
    return area;
  }
  async updateArea(tenantId: string, areaId: number, input: Partial<Pick<IngestionArea, "status" | "lastRunAt" | "startedAt" | "nextDueAt" | "lastError" | "foundSources">>) {
    const area = this.areas.find((a) => a.tenantId === tenantId && a.id === areaId);
    if (!area) throw new Error("Gebiet nicht gefunden");
    Object.assign(area, input);
    return area;
  }
  async createSourceVisit(tenantId: string, input: Omit<IngestionSourceVisit, "id" | "tenantId">) {
    const visit = { ...input, id: ++this.visitId, tenantId };
    this.sourceVisits.push(visit);
    return visit;
  }
  async listSourceVisits(tenantId: string, sourceId: number) {
    return this.sourceVisits.filter((v) => v.tenantId === tenantId && v.sourceId === sourceId);
  }
  async listDocuments(tenantId: string, filters: DocumentListFilters = {}) {
    return this.documents.filter((document) => {
      if (document.tenantId !== tenantId) return false;
      const value = this.classifications.get(`${tenantId}:${document.id}`);
      const actualityStatus = value?.actualityStatus ?? documentActualityStatus(value ?? null);
      if (filters.type && value?.type !== filters.type) return false;
      if (filters.actualityStatus && actualityStatus !== filters.actualityStatus) return false;
      if (filters.regionState && value?.regionState !== filters.regionState) return false;
      if (filters.regionDistrict && value?.regionDistrict !== filters.regionDistrict) return false;
      if (filters.periodYear != null
        && !periodIncludesYear(value?.periodStartYear, value?.periodEndYear, filters.periodYear)) return false;
      return true;
    }).map((document) => {
      const classification = this.classifications.get(`${tenantId}:${document.id}`) ?? null;
      return {
        ...document,
        classification,
        actualityStatus: classification?.actualityStatus ?? documentActualityStatus(classification),
        actualitySource: classification?.actualityStatus ? "manual" as const : "derived" as const,
        actualityDecidedAt: classification?.actualityDecidedAt ?? null,
        actualityDecidedBy: classification?.actualityDecidedBy ?? null,
      };
    });
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
      actualityStatus: null, actualityDecidedAt: null, actualityDecidedBy: null,
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
        actualityStatus: null,
        actualityDecidedAt: null,
        actualityDecidedBy: null,
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
  async decideDocumentActuality(tenantId: string, documentId: number, status: Exclude<ActualityStatus, "unverified">, actor: string) {
    const document = await this.getDocument(tenantId, documentId);
    const classification = this.classifications.get(`${tenantId}:${documentId}`);
    if (!classification) throw new Error("Dokumenteinordnung ist noch nicht vorhanden");
    classification.actualityStatus = status;
    classification.actualityDecidedAt = new Date();
    classification.actualityDecidedBy = actor;
    return {
      ...document,
      actualityStatus: status,
      actualitySource: "manual" as const,
      actualityDecidedAt: classification.actualityDecidedAt,
      actualityDecidedBy: actor,
    };
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
      actualityStatus: "unverified" as const,
      actualitySource: "derived" as const,
      actualityDecidedAt: null,
      actualityDecidedBy: null,
    };
    this.documents.push(document);
    return { document, deduplicated: false };
  }
  async getDocument(tenantId: string, documentId: number) {
    const document = this.documents.find((item) => item.tenantId === tenantId && item.id === documentId);
    if (!document) throw new Error("Dokument nicht gefunden");
    document.classification = this.classifications.get(`${tenantId}:${documentId}`) ?? null;
    document.actualityStatus = document.classification?.actualityStatus ?? documentActualityStatus(document.classification);
    document.actualitySource = document.classification?.actualityStatus ? "manual" : "derived";
    document.actualityDecidedAt = document.classification?.actualityDecidedAt ?? null;
    document.actualityDecidedBy = document.classification?.actualityDecidedBy ?? null;
    return document;
  }
  async getDocumentById(documentId: number) {
    const document = this.documents.find((item) => item.id === documentId);
    if (!document) throw new Error("Dokument nicht gefunden");
    document.classification = this.classifications.get(`${document.tenantId}:${documentId}`) ?? null;
    document.actualityStatus = document.classification?.actualityStatus ?? documentActualityStatus(document.classification);
    document.actualitySource = document.classification?.actualityStatus ? "manual" : "derived";
    document.actualityDecidedAt = document.classification?.actualityDecidedAt ?? null;
    document.actualityDecidedBy = document.classification?.actualityDecidedBy ?? null;
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
      contacts?: {
        phone: string | null;
        email: string | null;
        website: string | null;
        postalCode: string | null;
        city: string | null;
      } | null;
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
      contacts: item.contacts ?? null,
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
