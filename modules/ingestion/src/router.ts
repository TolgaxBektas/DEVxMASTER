import {
  appendAudit,
  permissionProcedure,
  protectedProcedure,
  router,
  type AuditRepository,
} from "@xmaster-center/kernel";
import { z } from "zod";
import type { IngestionRepository } from "./repository.js";
import type { PifReviewClient } from "./review-client.js";

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
  reviewClient?: PifReviewClient,
  reviewTenantId?: string,
  audit?: AuditRepository,
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
    review: router({
      list: permissionProcedure("ingestion.review.read")
        .input(z.object({
          data_source: z.enum(["xdata_nb_high_quality", "xdata_germany"]).optional(),
        }).optional())
        .query(async ({ ctx, input }) => {
        if (!reviewClient || !reviewTenantId) {
          return {
            enabled: false,
            message: "Die Prüfung ist für diesen Dienst nicht konfiguriert.",
            items: [],
          };
        }
        if (ctx.auth.tenantId !== reviewTenantId) {
          return {
            enabled: true,
            message: "Für diesen Mandanten sind keine Data-Factory-Prüffälle konfiguriert.",
            items: [],
          };
        }
        return { enabled: true, items: await reviewClient.listOpen(input?.data_source) };
      }),
      get: permissionProcedure("ingestion.review.read")
        .input(z.object({ id: z.number().int().positive() }))
        .query(async ({ ctx, input }) => {
          if (!reviewClient || !reviewTenantId) throw new Error("Die Prüfung ist nicht konfiguriert");
          if (ctx.auth.tenantId !== reviewTenantId) throw new Error("Prüffall gehört zu einem anderen Mandanten");
          return reviewClient.get(input.id);
        }),
      decide: permissionProcedure("ingestion.review.decide")
        .input(z.object({
          id: z.number().int().positive(),
          decision: z.enum(["approve", "reject"]),
          note: z.string().max(5000).optional(),
        }))
        .mutation(async ({ ctx, input }) => {
          if (!reviewClient || !reviewTenantId) throw new Error("Die Prüfung ist nicht konfiguriert");
          if (ctx.auth.tenantId !== reviewTenantId) throw new Error("Prüffall gehört zu einem anderen Mandanten");
          const result = await reviewClient.decide(input.id, input.decision, input.note);
          if (audit) {
            await appendAudit(audit, {
              tenantId: ctx.auth.tenantId,
              action: "ingestion.review.decided",
              entityType: "ingestion_review",
              entityId: input.id,
              actorId: ctx.auth.user.id,
              actorName: ctx.auth.user.displayName,
              detailsJson: JSON.stringify({
                decision: input.decision,
                note: input.note ?? null,
              }),
            });
          }
          return result;
        }),
    }),
  });
}
