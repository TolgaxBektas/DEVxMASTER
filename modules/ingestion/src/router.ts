import {
  appendAudit,
  permissionProcedure,
  protectedProcedure,
  router,
  type AuditRepository,
  TRPCError,
} from "@xmaster-center/kernel";
import { z } from "zod";
import type { IngestionRepository } from "./repository.js";

export const classificationCorrectionSchema = z.object({
  id: z.number().int().positive(),
  type: z.string().max(64, "Die Art darf höchstens 64 Zeichen lang sein.").nullable().optional(),
  publicationName: z.string().max(255, "Der Publikationsname darf höchstens 255 Zeichen lang sein.").nullable().optional(),
  editionLabel: z.string().max(128, "Die Ausgabe darf höchstens 128 Zeichen lang sein.").nullable().optional(),
  periodStartYear: z.number().int().min(1000, "Das Jahr muss mindestens 1000 sein.").max(2200, "Das Jahr darf höchstens 2200 sein.").nullable().optional(),
  periodEndYear: z.number().int().min(1000, "Das Jahr muss mindestens 1000 sein.").max(2200, "Das Jahr darf höchstens 2200 sein.").nullable().optional(),
  periodIssue: z.number().int().min(0, "Die Ausgabenummer darf nicht negativ sein.").max(10000, "Die Ausgabenummer darf höchstens 10000 sein.").nullable().optional(),
  regionPlace: z.string().max(255, "Der Ort darf höchstens 255 Zeichen lang sein.").nullable().optional(),
  regionDistrict: z.string().max(255, "Der Kreis darf höchstens 255 Zeichen lang sein.").nullable().optional(),
  regionState: z.string().max(255, "Das Bundesland darf höchstens 255 Zeichen lang sein.").nullable().optional(),
}).superRefine((value, context) => {
  if (value.periodStartYear != null && value.periodEndYear != null
    && value.periodEndYear < value.periodStartYear) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["periodEndYear"],
      message: "Das Endjahr darf nicht vor dem Startjahr liegen.",
    });
  }
});

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
      capabilities: protectedProcedure.query(({ ctx }) => ({
        correct: ctx.auth.permissions.has("ingestion.document.classify"),
      })),
      list: permissionProcedure("ingestion.document.read")
        .input(z.object({
          type: z.string().optional(),
          regionState: z.string().optional(),
          regionDistrict: z.string().optional(),
          periodYear: z.number().int().optional(),
        }).optional())
        .query(({ ctx, input }) => repository.listDocuments(
          ctx.auth.tenantId,
          Object.fromEntries(
            Object.entries(input ?? {}).filter(([, value]) => value !== undefined),
          ),
        )),
      correct: permissionProcedure("ingestion.document.classify")
        .input(classificationCorrectionSchema)
        .mutation(async ({ ctx, input }) => {
          if (!audit) throw new Error("Audit ist nicht konfiguriert");
          const { id, ...rawValue } = input;
          try {
            await repository.getDocument(ctx.auth.tenantId, id);
          } catch (error) {
            if (String(error).includes("Dokument nicht gefunden")) {
              throw new TRPCError({
                code: "NOT_FOUND",
                message: "Dokument nicht gefunden.",
              });
            }
            throw error;
          }
          const value = Object.fromEntries(
            Object.entries(rawValue).filter(([, item]) => item !== undefined),
          );
          if (Object.keys(value).length === 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Keine Änderung vorgenommen.",
            });
          }
          const result = await repository.updateClassificationManual(
            ctx.auth.tenantId,
            id,
            value,
            ctx.auth.user.id,
          );
          await appendAudit(audit, {
            tenantId: ctx.auth.tenantId,
            action: "ingestion.document.classification.corrected",
            entityType: "ingestion_document",
            entityId: id,
            actorId: ctx.auth.user.id,
            actorName: ctx.auth.user.displayName,
            detailsJson: JSON.stringify(value),
          });
          return result;
        }),
    }),
    occurrences: router({
      list: permissionProcedure("ingestion.occurrence.read").query(({ ctx }) =>
        repository.listOccurrences(ctx.auth.tenantId),
      ),
    }),
  });
}
