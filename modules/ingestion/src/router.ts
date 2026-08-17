import {
  appendAudit,
  permissionProcedure,
  protectedProcedure,
  router,
  type AuditRepository,
  TRPCError,
} from "@xmaster-center/kernel";
import { ZodError, z } from "zod";
import { IngestionSourceNotFoundError, type IngestionRepository } from "./repository.js";
import type { PifReviewClient } from "./review-client.js";
import type { ActualityStatus } from "./actuality.js";
import { publishCurrentActualityTransition } from "./actuality-replay.js";

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
  reviewClientOrAudit?: PifReviewClient | AuditRepository,
  reviewTenantId?: string,
  audit?: AuditRepository,
) {
  const reviewClient = reviewClientOrAudit && "listOpen" in reviewClientOrAudit
    ? reviewClientOrAudit as PifReviewClient
    : undefined;
  const effectiveAudit = audit ?? (
    reviewClientOrAudit && !("listOpen" in reviewClientOrAudit)
      ? reviewClientOrAudit as AuditRepository
      : undefined
  );
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
          if (!discover) throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Quellensuche ist nicht konfiguriert.",
          });
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
          let source;
          try {
            source = await repository.getSource(ctx.auth.tenantId, input.id);
          } catch (error) {
            if (error instanceof IngestionSourceNotFoundError) {
              throw new TRPCError({ code: "NOT_FOUND", message: "Quelle nicht gefunden." });
            }
            throw error;
          }
          if (source.status !== "approved") throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Quelle ist nicht freigegeben.",
          });
          if (!enqueue) throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Quellenabruf ist nicht konfiguriert.",
          });
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
          actualityStatus: z.enum(["current", "outdated", "unverified"]).optional(),
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
          if (!effectiveAudit) throw new Error("Audit ist nicht konfiguriert");
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
          const before = await repository.getDocument(ctx.auth.tenantId, id);
          const previousStatus = before.actualityStatus;
          const current = before.classification;
          const effectiveStart = value.periodStartYear !== undefined
            ? value.periodStartYear
            : current?.periodStartYear;
          const effectiveEnd = value.periodEndYear !== undefined
            ? value.periodEndYear
            : current?.periodEndYear;
          if (effectiveStart != null && effectiveEnd != null && effectiveEnd < effectiveStart) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Das Endjahr darf nicht vor dem Startjahr liegen.",
              cause: new ZodError([{
                code: z.ZodIssueCode.custom,
                path: ["periodEndYear"],
                message: "Das Endjahr darf nicht vor dem Startjahr liegen.",
              }]),
            });
          }
          const result = await repository.updateClassificationManual(
            ctx.auth.tenantId,
            id,
            value,
            ctx.auth.user.id,
          );
          const after = await repository.getDocument(ctx.auth.tenantId, id);
          await publishCurrentActualityTransition({
            tenantId: ctx.auth.tenantId,
            document: after,
            previousStatus,
            currentStatus: after.actualityStatus,
            occurrences: await repository.listOccurrences(ctx.auth.tenantId),
            publish,
          });
          await appendAudit(effectiveAudit, {
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
      actuality: permissionProcedure("ingestion.document.classify")
        .input(z.object({
          id: z.number().int().positive(),
          status: z.enum(["current", "outdated"]),
        }))
        .mutation(async ({ ctx, input }) => {
          if (!effectiveAudit) throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Audit ist nicht konfiguriert.",
          });
          const current = await repository.getDocument(ctx.auth.tenantId, input.id);
          const previousStatus = current.actualityStatus;
          if (current.actualityStatus === input.status) return current;
          const result = await repository.decideDocumentActuality(
            ctx.auth.tenantId,
            input.id,
            input.status as Exclude<ActualityStatus, "unverified">,
            ctx.auth.user.id,
          );
          await publishCurrentActualityTransition({
            tenantId: ctx.auth.tenantId,
            document: result,
            previousStatus,
            currentStatus: result.actualityStatus,
            occurrences: await repository.listOccurrences(ctx.auth.tenantId),
            publish,
          });
          await appendAudit(effectiveAudit, {
            tenantId: ctx.auth.tenantId,
            action: "ingestion.document.actuality.decided",
            entityType: "ingestion_document",
            entityId: input.id,
            actorId: ctx.auth.user.id,
            actorName: ctx.auth.user.displayName,
            detailsJson: JSON.stringify({ status: input.status }),
          });
          return result;
        }),
    }),
    occurrences: router({
      capabilities: protectedProcedure.query(({ ctx }) => ({
        review: ctx.auth.permissions.has("ingestion.occurrence.review"),
      })),
      list: permissionProcedure("ingestion.occurrence.read").query(({ ctx }) =>
        repository.listOccurrences(ctx.auth.tenantId),
      ),
      review: permissionProcedure("ingestion.occurrence.review")
        .input(z.object({
          id: z.number().int().positive(),
          decision: z.enum(["approved", "rejected"]),
        }))
        .mutation(async ({ ctx, input }) => {
          if (!effectiveAudit) throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Audit ist nicht konfiguriert.",
          });
          let result;
          try {
            result = await repository.reviewOccurrence(
              ctx.auth.tenantId,
              input.id,
              input.decision,
            );
          } catch (error) {
            if (String(error).includes("Fundstelle nicht gefunden")) {
              throw new TRPCError({
                code: "NOT_FOUND",
                message: "Fundstelle nicht gefunden.",
              });
            }
            throw error;
          }
          if (result.changed) {
            await appendAudit(effectiveAudit, {
              tenantId: ctx.auth.tenantId,
              action: `ingestion.occurrence.${input.decision}`,
              entityType: "ingestion_occurrence",
              entityId: input.id,
              actorId: ctx.auth.user.id,
              actorName: ctx.auth.user.displayName,
              detailsJson: JSON.stringify({ status: input.decision }),
            });
          }
          return result.occurrence;
        }),
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
          if (effectiveAudit) {
            await appendAudit(effectiveAudit, {
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
