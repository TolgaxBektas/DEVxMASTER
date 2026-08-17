import {
  appendAudit,
  createDrizzleAuditRepository,
  createDrizzleEventRepository,
  defineModule,
  type EventExecutor,
  type ModuleDefinition,
} from "@xmaster-center/kernel";
import type { Storage } from "@xmaster-center/integrations";
import { ingestionSchema } from "./schema.js";
import { createIngestionRouter } from "./router.js";
import { MemoryIngestionRepository } from "./memory-repository.js";
import { createDrizzleIngestionRepository } from "./drizzle-repository.js";
import { occurrenceFingerprint, type IngestionRepository } from "./repository.js";
import { registerReviewImageRoutes, registerUploadRoute } from "./rest.js";
import { persistDocumentBytes } from "./rest.js";
import { deriveDocumentClassification } from "./classification.js";
import { documentActualityStatus } from "./actuality.js";
import { ingestionPages, IngestionPage, OccurrencesPage, ReviewPage } from "./ui/index.js";
import type { PifReviewClient } from "./review-client.js";

export type AdBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
};

export type ProcessedPage = {
  pageNumber: number;
  text: string;
  imageKey: string;
  classification: string;
  adProbability: number;
  titleCandidates?: Array<{ text: string; size: number }>;
  occurrences: Array<{
    bbox: AdBoundingBox;
    imageKey: string;
    confidence: number;
    evidence: string[];
    company: string;
    preview: string;
  }>;
};

type JobContext = { job: { tenantId: string | null } };

export function advertisementEventIdempotencyKey(
  tenantId: string,
  documentSha256: string,
  occurrence: {
    pageNumber?: number;
    company: string;
    preview: string;
    bbox?: Record<string, number> | null;
  },
): string {
  return `advertisement.detected:${tenantId}:${documentSha256}:page-${occurrence.pageNumber ?? "unknown"}:${occurrenceFingerprint(occurrence)}`;
}

function jobTenantId(context: unknown) {
  const tenantId = (context as JobContext).job?.tenantId;
  if (!tenantId) throw new Error("Mandant für Job fehlt");
  return tenantId;
}

function jobDocumentId(payload: unknown) {
  const documentId = (payload as { documentId?: unknown }).documentId;
  return typeof documentId === "number" ? documentId : null;
}

export function createIngestionModule(deps: {
  db?: unknown;
  repository?: IngestionRepository;
  audit?: ReturnType<typeof createDrizzleAuditRepository>;
  storage?: Storage;
  maxUploadBytes?: number;
  transaction?: <T>(callback: (db: unknown) => Promise<T>) => Promise<T>;
  repositoryForTransaction?: (db: unknown) => IngestionRepository;
  enqueue?: (input: { name: string; tenantId?: string | null; payload: unknown }) => Promise<unknown>;
  publish(input: {
    name: string;
    tenantId: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }, executor?: EventExecutor): Promise<unknown>;
  processDocument?: (input: {
    tenantId: string;
    documentId: number;
    storageKey: string;
    outputPrefix: string;
  }) => Promise<ProcessedPage[] & { pdfMetadata?: {
    title?: string;
    subject?: string;
    creationDate?: string;
  } }>;
  fetchSource?: (input: { url: string }) => Promise<{ bytes: Buffer; filename: string }>;
  discoverProposals?: (input: { seedPages: string[]; searchTerms: string[]; maxResults: number }) => Promise<Array<{
    url: string; score: number; metadata: Record<string, unknown>;
  }>>;
  reviewClient?: PifReviewClient;
  reviewTenantId?: string;
}): ModuleDefinition {
  const repository = deps.repository ?? (deps.db
    ? createDrizzleIngestionRepository(deps.db)
    : new MemoryIngestionRepository());
  return defineModule({
    id: "ingestion",
    title: "Dokumente",
    icon: "file",
    version: "0.1.0",
    schema: ingestionSchema,
    router: createIngestionRouter(
      repository,
      deps.publish,
      deps.enqueue,
      deps.discoverProposals,
      deps.reviewClient,
      deps.reviewTenantId,
      deps.audit,
    ),
    ...(deps.db && deps.storage && deps.audit && deps.transaction && deps.enqueue
      ? {
          rest: (app: Parameters<typeof registerUploadRoute>[0]) => {
            registerUploadRoute(app, {
              db: deps.db!,
              repository,
              ...(deps.repositoryForTransaction
                ? { repositoryFor: (db: unknown) => createDrizzleIngestionRepository(db) }
                : {}),
              storage: deps.storage as Storage,
              audit: deps.audit as ReturnType<typeof createDrizzleAuditRepository>,
              auditFor: (db) => createDrizzleAuditRepository(db),
              transaction: deps.transaction as <T>(callback: (db: unknown) => Promise<T>) => Promise<T>,
              publish: deps.publish,
              enqueue: (input) => deps.enqueue!(input),
              maxUploadBytes: deps.maxUploadBytes ?? 25 * 1024 * 1024,
            });
            if (deps.reviewClient) {
              registerReviewImageRoutes(app, {
                reviewClient: deps.reviewClient,
                ...(deps.reviewTenantId ? { reviewTenantId: deps.reviewTenantId } : {}),
              });
            }
          },
        }
      : {}),
    nav: [
      { id: "ingestion.sources", label: "Quellen", href: "/ingestion/sources", permission: "ingestion.source.read", order: 5 },
      { id: "ingestion.documents", label: "Dokumente", href: "/ingestion", permission: "ingestion.document.read", order: 10 },
      { id: "ingestion.occurrences", label: "Fundstellen", href: "/ingestion/occurrences", permission: "ingestion.occurrence.read", order: 20 },
    ],
    pages: ingestionPages.map(([id, title, path, permission]) => ({
      id,
      title,
      path,
      permission,
      component: path === "/ingestion/occurrences"
        ? OccurrencesPage
        : path === "/ingestion/review"
          ? ReviewPage
          : IngestionPage,
    })),
    permissions: [
      { permission: "ingestion.source.read", title: "Quellen lesen" },
      { permission: "ingestion.source.search", title: "Quellen suchen" },
      { permission: "ingestion.source.approve", title: "Quellen freigeben" },
      { permission: "ingestion.source.fetch", title: "Quellen abrufen" },
      { permission: "ingestion.document.read", title: "Dokumente lesen" },
      { permission: "ingestion.document.write", title: "Dokumente aufnehmen" },
      { permission: "ingestion.document.upload", title: "Dokumente hochladen" },
      { permission: "ingestion.document.classify", title: "Dokumente einordnen" },
      { permission: "ingestion.occurrence.read", title: "Fundstellen lesen" },
      { permission: "ingestion.occurrence.review", title: "Fundstellen entscheiden" },
      { permission: "ingestion.review.read", title: "Prüffälle lesen" },
      { permission: "ingestion.review.decide", title: "Prüffälle entscheiden" },
    ],
    jobs: [
      {
        name: "ingestion.discovery.run",
        schedule: "daily",
        handle: async (payload, context) => {
          const tenantId = jobTenantId(context);
          if (deps.enqueue) await deps.enqueue({
            name: "ingestion.processing.run",
            tenantId,
            payload: {},
          });
        },
      },
      {
        name: "ingestion.source.fetch",
        schedule: "daily",
        handle: async (payload, context) => {
          const tenantId = jobTenantId(context);
          const sourceId = (payload as { sourceId?: unknown }).sourceId;
          if (typeof sourceId !== "number") throw new Error("Quelle für Abruf fehlt");
          const source = await repository.getSource(tenantId, sourceId);
          if (source.status !== "approved") throw new Error("Quelle ist nicht freigegeben");
          if (!deps.fetchSource) throw new Error("Quellenabruf ist nicht konfiguriert");
          try {
            const fetched = await deps.fetchSource({ url: source.url });
            const result = await persistDocumentBytes({
              db: deps.db,
              repository,
              ...(deps.repositoryForTransaction
                ? { repositoryFor: deps.repositoryForTransaction }
                : {}),
              storage: deps.storage!,
              audit: deps.audit!,
              auditFor: (db) => createDrizzleAuditRepository(db),
              transaction: deps.transaction!,
              publish: deps.publish,
              enqueue: deps.enqueue!,
              maxUploadBytes: 250 * 1024 * 1024,
            }, {
              tenantId,
              userId: null,
              displayName: "Ingestion-Worker",
              bytes: fetched.bytes,
              filename: fetched.filename,
              origin: "source",
              sourceId,
            });
            await repository.updateSource(tenantId, sourceId, {
              lastFetchedAt: new Date(),
              lastError: null,
            });
            if (!result.deduplicated) {
              await deps.enqueue!({ name: "ingestion.processing.run", tenantId, payload: { documentId: result.document.id } });
            }
          } catch (error) {
            await repository.updateSource(tenantId, sourceId, {
              lastError: error instanceof Error ? error.message : "Quellenabruf fehlgeschlagen",
            });
            throw error;
          }
        },
      },
      {
        name: "ingestion.processing.run",
        schedule: "daily",
        handle: async (payload, context) => {
          const tenantId = jobTenantId(context);
          const documentId = (payload as { documentId?: unknown }).documentId;
          const documents = typeof documentId === "number"
            ? [await repository.getDocument(tenantId, documentId)]
            : await repository.listDocuments(tenantId);
          for (const document of documents.filter((item) => item.state === "uploaded" || item.state === "failed")) {
            if (!deps.processDocument || !deps.transaction) {
              await repository.setDocumentState(tenantId, document.id, "failed", "Verarbeitung ist nicht konfiguriert");
              continue;
            }
            await repository.setDocumentState(tenantId, document.id, "processing");
            try {
              const pages = await deps.processDocument({
                tenantId,
                documentId: document.id,
                storageKey: document.storageKey,
                outputPrefix: `tenants/${tenantId}/processed/${document.sha256}`,
              });
              await deps.transaction(async (db) => {
                const txRepository = deps.repositoryForTransaction?.(db)
                  ?? createDrizzleIngestionRepository(db);
              await txRepository.upsertDerivedClassification(
                tenantId,
                document.id,
                deriveDocumentClassification({
                  filename: document.filename,
                  pages,
                  ...(pages.pdfMetadata ? { pdfMetadata: pages.pdfMetadata } : {}),
                }),
              );
              const occurrences = await txRepository.replaceProcessedDocument(
                tenantId,
                document.id,
                pages,
              );
              const processedDocument = await txRepository.getDocument(tenantId, document.id);
              const executor = createDrizzleEventRepository(db);
              const actualityStatus = processedDocument.actualityStatus
                ?? documentActualityStatus(processedDocument.classification);
              for (const occurrence of occurrences) {
                await deps.publish({
                  name: "advertisement.detected",
                  tenantId,
                  aggregateType: "occurrence",
                  aggregateId: String(occurrence.id),
                  payload: {
                    occurrenceId: occurrence.id,
                    documentId: document.id,
                    company: occurrence.company,
                    preview: occurrence.preview,
                    actualityStatus,
                  },
                  idempotencyKey: advertisementEventIdempotencyKey(
                    tenantId,
                    document.sha256,
                    occurrence,
                  ),
                }, executor);
              }
              if (deps.audit) {
                await appendAudit(createDrizzleAuditRepository(db), {
                  tenantId,
                  action: "ingestion.document.processed",
                  entityType: "ingestion_document",
                  entityId: document.id,
                  actorId: null,
                  actorName: "Ingestion-Worker",
                  detailsJson: JSON.stringify({ occurrences: occurrences.length }),
                });
              }
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : "Verarbeitung fehlgeschlagen";
              await repository.setDocumentState(tenantId, document.id, "failed", message);
              throw error;
            }
          }
        },
        onFailure: async (error, context) => {
          const documentId = jobDocumentId((context as { job: { payload: unknown } }).job.payload);
          if (documentId === null) return;
          const message = error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Verarbeitung fehlgeschlagen";
          let tenantId: string;
          try {
            tenantId = jobTenantId(context);
          } catch {
            const document = await repository.getDocumentById(documentId);
            tenantId = document.tenantId;
          }
          const document = await repository.getDocument(tenantId, documentId);
          if (document.state !== "failed") {
            await repository.setDocumentState(tenantId, documentId, "failed", message);
          }
        },
      },
    ],
    events: [
      { name: "document.ingested", direction: "published" },
      { name: "advertisement.detected", direction: "published" },
    ],
    health: () => ({ id: "ingestion", status: "healthy" }),
  });
}
