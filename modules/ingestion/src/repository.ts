import { createHash } from "node:crypto";
import type { DerivedClassification, DocumentClassification } from "./classification.js";
import type { ActualityStatus } from "./actuality.js";

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
  areaId: number | null;
  revisitIntervalDays: number;
  nextCheckAt: Date | null;
  productive: boolean;
  fingerprint: string | null;
  revisitFailures: number;
  lastCheckedAt?: Date | null;
  actualityHint?: ActualityStatus | null;
};
export type IngestionArea = {
  id: number;
  tenantId: string;
  level: "state" | "district";
  ags: string;
  name: string;
  stateName: string;
  kind: string;
  orderIndex: number;
  status: "pending" | "running" | "done";
  lastRunAt: Date | null;
  startedAt: Date | null;
  nextDueAt: Date | null;
  lastError: string | null;
  foundSources: number;
  createdAt: Date;
};
export type IngestionSourceVisit = {
  id: number;
  tenantId: string;
  sourceId: number;
  checkedAt: Date;
  httpStatus: number | null;
  newPdfCount: number;
  changed: boolean;
  note: string | null;
};

function normalizeOccurrenceText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("de-DE").trim().replace(/\s+/g, " ");
}

export function occurrenceFingerprint(occurrence: {
  pageNumber?: number;
  company: string;
  preview: string;
  bbox?: Record<string, number> | null;
}): string {
  const bbox = ["x", "y", "width", "height", "confidence"]
    .map((key) => {
      const value = occurrence.bbox?.[key];
      return `${key}=${typeof value === "number" && Number.isFinite(value)
        ? Math.round(value * 1000) / 1000
        : ""}`;
    })
    .join(",");
  return createHash("sha256")
    .update([
      occurrence.pageNumber ?? "",
      normalizeOccurrenceText(occurrence.company),
      normalizeOccurrenceText(occurrence.preview),
      bbox,
    ].join("\u001f"))
    .digest("hex")
    .slice(0, 24);
}

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
  actualityStatus: ActualityStatus;
  actualitySource: "derived" | "manual";
  actualityDecidedAt: Date | null;
  actualityDecidedBy: string | null;
};
export type DocumentListFilters = {
  type?: string;
  regionState?: string;
  regionDistrict?: string;
  periodYear?: number;
  actualityStatus?: ActualityStatus;
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
  contacts?: {
    phone: string | null;
    email: string | null;
    website: string | null;
    postalCode: string | null;
    city: string | null;
  } | null;
};
export type OccurrenceReviewResult = {
  occurrence: IngestionOccurrence;
  changed: boolean;
};
export type IngestionRepository = {
  listSources(tenantId: string): Promise<IngestionSource[]>;
  createSource(tenantId: string, input: {
    url: string; score: number; metadata: Record<string, unknown>;
    areaId?: number | null; revisitIntervalDays?: number; nextCheckAt?: Date | null;
  }): Promise<IngestionSource>;
  getSource(tenantId: string, sourceId: number): Promise<IngestionSource>;
  updateSource(tenantId: string, sourceId: number, input: {
    status?: string;
    approvedBy?: string | null;
    approvedAt?: Date | null;
    lastFetchedAt?: Date | null;
    lastError?: string | null;
    areaId?: number | null;
    revisitIntervalDays?: number;
    nextCheckAt?: Date | null;
    productive?: boolean;
    fingerprint?: string | null;
    revisitFailures?: number;
  }): Promise<IngestionSource>;
  listAreas(tenantId: string): Promise<IngestionArea[]>;
  upsertArea(tenantId: string, input: Omit<IngestionArea, "id" | "tenantId" | "createdAt">): Promise<IngestionArea>;
  updateArea(tenantId: string, areaId: number, input: Partial<Pick<IngestionArea, "status" | "lastRunAt" | "startedAt" | "nextDueAt" | "lastError" | "foundSources">>): Promise<IngestionArea>;
  createSourceVisit(tenantId: string, input: Omit<IngestionSourceVisit, "id" | "tenantId">): Promise<IngestionSourceVisit>;
  listSourceVisits(tenantId: string, sourceId: number): Promise<IngestionSourceVisit[]>;
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
  decideDocumentActuality(
    tenantId: string,
    documentId: number,
    status: Exclude<ActualityStatus, "unverified">,
    actor: string,
  ): Promise<IngestionDocument>;
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
        contacts?: {
          phone: string | null;
          email: string | null;
          website: string | null;
          postalCode: string | null;
          city: string | null;
        } | null;
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
