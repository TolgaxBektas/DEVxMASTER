import { defineModule, type ModuleDefinition } from "@xmaster-center/kernel";
import { ingestionSchema } from "./schema.js";
import { createIngestionRouter } from "./router.js";
import { MemoryIngestionRepository } from "./memory-repository.js";
import { ingestionPages, IngestionPage } from "./ui/index.js";

export function createIngestionModule(deps: {
  publish(input: {
    name: string;
    tenantId: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<unknown>;
}): ModuleDefinition {
  const repository = new MemoryIngestionRepository();
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
    pages: ingestionPages.map(([id, title, path, permission]) => ({ id, title, path, permission, component: IngestionPage })),
    permissions: [
      { permission: "ingestion.source.read", title: "Quellen lesen" },
      { permission: "ingestion.document.read", title: "Dokumente lesen" },
      { permission: "ingestion.document.write", title: "Dokumente aufnehmen" },
      { permission: "ingestion.occurrence.read", title: "Fundstellen lesen" },
    ],
    jobs: [],
    events: [
      { name: "document.ingested", direction: "published" },
      { name: "advertisement.detected", direction: "published" },
    ],
    health: () => ({ id: "ingestion", status: "healthy" }),
  });
}
