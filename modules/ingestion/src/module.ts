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
import type { IngestionRepository } from "./repository.js";
import { registerUploadRoute } from "./rest.js";
import { ingestionPages, IngestionPage, OccurrencesPage } from "./ui/index.js";

export type ProcessedPage = {
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
};

type JobContext = { job: { tenantId: string | null } };

function jobTenantId(context: unknown) {
  const tenantId = (context as JobContext).job?.tenantId;
  if (!tenantId) throw new Error("Mandant für Job fehlt");
  return tenantId;
}

function jobDocumentId(payload: unknown) {
  const documentId = (payload as { documentId?: unknown }).documentId;
  if (typeof documentId !== "number") throw new Error("Dokument für Job fehlt");
  return documentId;
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
  }) => Promise<ProcessedPage[]>;
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
    router: createIngestionRouter(repository, deps.publish),
    ...(deps.db && deps.storage && deps.audit && deps.transaction && deps.enqueue
      ? {
          rest: (app: Parameters<typeof registerUploadRoute>[0]) =>
            registerUploadRoute(app, {
              db: deps.db,
              repository,
              repositoryFor: (db) => createDrizzleIngestionRepository(db),
              storage: deps.storage as Storage,
              audit: deps.audit as ReturnType<typeof createDrizzleAuditRepository>,
              auditFor: (db) => createDrizzleAuditRepository(db),
              transaction: deps.transaction as <T>(callback: (db: unknown) => Promise<T>) => Promise<T>,
              publish: deps.publish,
              enqueue: (input) => deps.enqueue!(input),
              maxUploadBytes: deps.maxUploadBytes ?? 25 * 1024 * 1024,
            }),
        }
      : {}),
    nav: [
      { id: "ingestion.documents", label: "Dokumente", href: "/ingestion", permission: "ingestion.document.read", order: 10 },
      { id: "ingestion.occurrences", label: "Fundstellen", href: "/ingestion/occurrences", permission: "ingestion.occurrence.read", order: 20 },
    ],
    pages: ingestionPages.map(([id, title, path, permission]) => ({
      id,
      title,
      path,
      permission,
      component: path === "/ingestion/occurrences" ? OccurrencesPage : IngestionPage,
    })),
    permissions: [
      { permission: "ingestion.source.read", title: "Quellen lesen" },
      { permission: "ingestion.document.read", title: "Dokumente lesen" },
      { permission: "ingestion.document.write", title: "Dokumente aufnehmen" },
      { permission: "ingestion.document.upload", title: "Dokumente hochladen" },
      { permission: "ingestion.occurrence.read", title: "Fundstellen lesen" },
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
                const occurrences = await txRepository.replaceProcessedDocument(
                  tenantId,
                  document.id,
                  pages,
                );
                const executor = createDrizzleEventRepository(db);
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
                    },
                    idempotencyKey: `advertisement.detected:${tenantId}:${document.sha256}:${occurrence.company}`,
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
          const tenantId = jobTenantId(context);
          const documentId = jobDocumentId((context as { job: { payload: unknown } }).job.payload);
          const message = error instanceof Error ? error.message : "Verarbeitung fehlgeschlagen";
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
