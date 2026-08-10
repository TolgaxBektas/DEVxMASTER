import { defineModule, type ModuleDefinition } from "@xmaster-center/kernel";
import { ingestionSchema } from "./schema.js";
import { createIngestionRouter } from "./router.js";
import { MemoryIngestionRepository } from "./memory-repository.js";
import { createDrizzleIngestionRepository } from "./drizzle-repository.js";
import { ingestionPages, IngestionPage, OccurrencesPage } from "./ui/index.js";

export function createIngestionModule(deps: {
  db?: unknown;
  enqueue?: (input: { name: string; tenantId?: string | null; payload: unknown }) => Promise<unknown>;
  publish(input: {
    name: string;
    tenantId: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<unknown>;
}): ModuleDefinition {
  const repository = deps.db
    ? createDrizzleIngestionRepository(deps.db)
    : new MemoryIngestionRepository();
  return defineModule({
    id: "ingestion",
    title: "Dokumente",
    icon: "file",
    version: "0.1.0",
    schema: ingestionSchema,
    router: createIngestionRouter(repository, deps.publish),
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
      { permission: "ingestion.occurrence.read", title: "Fundstellen lesen" },
    ],
    jobs: [
      {
        name: "ingestion.discovery.run",
        schedule: "daily",
        handle: async (payload) => {
          const tenantId = String((payload as { tenantId?: string }).tenantId ?? "1");
          const result = await repository.ingestDemo(tenantId);
          await deps.publish({
            name: "document.ingested",
            tenantId,
            aggregateType: "document",
            aggregateId: String(result.document.id),
            payload: { documentId: result.document.id },
            idempotencyKey: `document.ingested:${result.document.sha256}`,
          });
        },
      },
      {
        name: "ingestion.processing.run",
        schedule: "daily",
        handle: async (payload) => {
          const tenantId = String((payload as { tenantId?: string }).tenantId ?? "1");
          const documents = await repository.listDocuments(tenantId);
          for (const document of documents.filter((item) => item.state === "discovered")) {
            await repository.setDocumentState(tenantId, document.id, "processed");
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
