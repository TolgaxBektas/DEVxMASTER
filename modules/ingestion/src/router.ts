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
    }),
    occurrences: router({
      list: permissionProcedure("ingestion.occurrence.read").query(({ ctx }) =>
        repository.listOccurrences(ctx.auth.tenantId),
      ),
    }),
  });
}
