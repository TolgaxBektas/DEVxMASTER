import { permissionProcedure, router } from "@xmaster-center/kernel";
import type { IngestionRepository } from "./repository.js";

export function createIngestionRouter(
  repository: IngestionRepository,
  publish: (input: {
    name: string;
    tenantId: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }) => Promise<unknown>,
) {
  return router({
    sources: router({
      list: permissionProcedure("ingestion.source.read").query(({ ctx }) =>
        repository.listSources(ctx.auth.tenantId),
      ),
    }),
    documents: router({
      list: permissionProcedure("ingestion.document.read").query(({ ctx }) =>
        repository.listDocuments(ctx.auth.tenantId),
      ),
      ingestDemo: permissionProcedure("ingestion.document.write").mutation(
        async ({ ctx }) => {
          const result = await repository.ingestDemo(ctx.auth.tenantId);
          await publish({
            name: "document.ingested",
            tenantId: ctx.auth.tenantId,
            aggregateType: "document",
            aggregateId: String(result.document.id),
            payload: { documentId: result.document.id },
            idempotencyKey: `document.ingested:${result.document.sha256}`,
          });
          await publish({
            name: "advertisement.detected",
            tenantId: ctx.auth.tenantId,
            aggregateType: "occurrence",
            aggregateId: String(result.occurrence.id),
            payload: {
              occurrenceId: result.occurrence.id,
              documentId: result.document.id,
              company: result.occurrence.company,
              preview: result.occurrence.preview,
            },
            idempotencyKey: `advertisement.detected:${result.document.sha256}`,
          });
          return result;
        },
      ),
    }),
    occurrences: router({
      list: permissionProcedure("ingestion.occurrence.read").query(({ ctx }) =>
        repository.listOccurrences(ctx.auth.tenantId),
      ),
    }),
  });
}
