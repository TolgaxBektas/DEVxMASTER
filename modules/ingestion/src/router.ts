import { permissionProcedure, protectedProcedure, router } from "@xmaster-center/kernel";
import { z } from "zod";
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
  enqueue?: (input: { name: string; tenantId?: string | null; payload: unknown }) => Promise<unknown>,
  discover?: (input: { seedPages: string[]; searchTerms: string[]; maxResults: number }) => Promise<Array<{
    url: string; score: number; metadata: Record<string, unknown>;
  }>>,
) {
  return router({
    sources: router({
      capabilities: protectedProcedure.query(({ ctx }) => ({
        search: ctx.auth.permissions.has("ingestion.source.search"),
        approve: ctx.auth.permissions.has("ingestion.source.approve"),
        fetch: ctx.auth.permissions.has("ingestion.source.fetch"),
      })),
      list: permissionProcedure("ingestion.source.read").query(({ ctx }) =>
        repository.listSources(ctx.auth.tenantId),
      ),
      search: permissionProcedure("ingestion.source.search")
        .input(z.object({
          seedPages: z.array(z.string().url()).default([]),
          searchTerms: z.array(z.string().min(1)).default([]),
          maxResults: z.number().int().positive().max(100).default(25),
        }))
        .mutation(async ({ ctx, input }) => {
          if (!discover) throw new Error("Quellensuche ist nicht konfiguriert");
          const proposals = await discover({
            seedPages: input.seedPages,
            searchTerms: input.searchTerms,
            maxResults: input.maxResults,
          });
          return Promise.all(proposals.map((proposal) => repository.createSource(ctx.auth.tenantId, proposal)));
        }),
      approve: permissionProcedure("ingestion.source.approve")
        .input(z.object({ id: z.number().int().positive() }))
        .mutation(async ({ ctx, input }) => {
          const source = await repository.updateSource(ctx.auth.tenantId, input.id, {
            status: "approved",
            approvedBy: ctx.auth.user.id,
            approvedAt: new Date(),
            lastError: null,
          });
          await publish({
            name: "ingestion.source.approved",
            tenantId: ctx.auth.tenantId,
            aggregateType: "source",
            aggregateId: String(input.id),
            payload: { sourceId: input.id, url: source.url },
            idempotencyKey: `ingestion.source.approved:${ctx.auth.tenantId}:${input.id}`,
          });
          return source;
        }),
      reject: permissionProcedure("ingestion.source.approve")
        .input(z.object({ id: z.number().int().positive() }))
        .mutation(({ ctx, input }) => repository.updateSource(ctx.auth.tenantId, input.id, {
          status: "rejected",
          approvedBy: null,
          approvedAt: null,
        })),
      fetch: permissionProcedure("ingestion.source.fetch")
        .input(z.object({ id: z.number().int().positive() }))
        .mutation(async ({ ctx, input }) => {
          const source = await repository.getSource(ctx.auth.tenantId, input.id);
          if (source.status !== "approved") throw new Error("Quelle ist nicht freigegeben");
          if (!enqueue) throw new Error("Quellenabruf ist nicht konfiguriert");
          return enqueue({
            name: "ingestion.source.fetch",
            tenantId: ctx.auth.tenantId,
            payload: { sourceId: input.id },
          });
        }),
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
