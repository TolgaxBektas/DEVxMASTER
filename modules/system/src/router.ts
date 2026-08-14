import { and, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  aiUsageLedger,
  appendAudit,
  auditLog,
  automationPolicies,
  eventOutbox,
  featureFlags,
  jobs,
  permissionProcedure,
  router,
  TRPCError,
  verifyAuditChain,
  type AuditRepository,
} from "@xmaster-center/kernel";
import type { EventRepository } from "@xmaster-center/kernel";
import type { LeaseQueue } from "@xmaster-center/jobs";

export function createSystemRouter(deps: {
  db: any;
  audit: AuditRepository;
  events: EventRepository;
  queue: LeaseQueue;
  health(): Promise<unknown>;
  navigation(permissions: ReadonlySet<string>): unknown[];
}) {
  return router({
    health: permissionProcedure("system.health.read").query(() =>
      deps.health(),
    ),
    navigation: permissionProcedure("system.health.read").query(({ ctx }) =>
      deps.navigation(ctx.auth.permissions),
    ),
    permissions: permissionProcedure("system.health.read").query(({ ctx }) =>
      [...ctx.auth.permissions],
    ),
    audit: router({
      list: permissionProcedure("system.audit.read").query(({ ctx }) =>
        deps.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.tenantId, Number(ctx.auth.tenantId)))
          .orderBy(desc(auditLog.seq))
          .limit(100),
      ),
      verify: permissionProcedure("system.audit.read").query(({ ctx }) =>
        verifyAuditChain(
          deps.audit,
          ctx.auth.permissions.has("system.audit.global.verify")
            ? undefined
            : ctx.auth.tenantId,
        ),
      ),
    }),
    jobs: router({
      list: permissionProcedure("system.jobs.read").query(({ ctx }) =>
        deps.db
          .select()
          .from(jobs)
          .where(
            or(
              eq(jobs.tenantId, Number(ctx.auth.tenantId)),
              isNull(jobs.tenantId),
            ),
          )
          .orderBy(desc(jobs.updatedAt))
          .limit(100),
      ),
      requeue: permissionProcedure("system.jobs.requeue")
        .input(z.object({ id: z.string().uuid() }))
        .mutation(async ({ ctx, input }) => {
          const current = (
            await deps.db
              .select()
              .from(jobs)
              .where(eq(jobs.id, input.id))
              .limit(1)
          )[0];
          if (
            !current ||
            (current.tenantId !== null &&
              current.tenantId !== Number(ctx.auth.tenantId))
          ) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Job nicht gefunden." });
          }
          let job;
          try {
            job = await deps.queue.requeue(input.id);
          } catch (error) {
            if (String(error).includes("Nur tote Jobs")) {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: "Nur tote Jobs können erneut eingereiht werden.",
              });
            }
            throw error;
          }
          if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job nicht gefunden." });
          await appendAudit(deps.audit, {
            tenantId: ctx.auth.tenantId,
            action: "job.requeued",
            entityType: "job",
            entityId: job.id,
            actorId: ctx.auth.user.id,
            actorName: ctx.auth.user.displayName,
            detailsJson: JSON.stringify({ name: job.name }),
          });
          return job;
        }),
    }),
    events: router({
      list: permissionProcedure("system.events.read").query(({ ctx }) =>
        deps.db
          .select()
          .from(eventOutbox)
          .where(eq(eventOutbox.tenantId, Number(ctx.auth.tenantId)))
          .orderBy(desc(eventOutbox.createdAt))
          .limit(100),
      ),
      requeue: permissionProcedure("system.events.requeue")
        .input(z.object({ id: z.string().uuid() }))
        .mutation(async ({ ctx, input }) => {
          const current = (
            await deps.db
              .select()
              .from(eventOutbox)
              .where(
                and(
                  eq(eventOutbox.eventId, input.id),
                  eq(eventOutbox.tenantId, Number(ctx.auth.tenantId)),
                ),
              )
              .limit(1)
          )[0];
          if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Event nicht gefunden." });
          let event;
          try {
            event = await deps.events.requeue(input.id);
          } catch (error) {
            if (String(error).includes("Nur Dead Letters")) {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: "Nur Dead Letters können erneut zugestellt werden.",
              });
            }
            throw error;
          }
          if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "Event nicht gefunden." });
          await appendAudit(deps.audit, {
            tenantId: ctx.auth.tenantId,
            action: "event.requeued",
            entityType: "event",
            entityId: event.id,
            actorId: ctx.auth.user.id,
            actorName: ctx.auth.user.displayName,
            detailsJson: JSON.stringify({ name: event.name }),
          });
          return event;
        }),
    }),
    ai: router({
      costs: permissionProcedure("system.ai.read")
        .query(({ ctx }) =>
          deps.db
            .select()
            .from(aiUsageLedger)
            .where(eq(aiUsageLedger.tenantId, Number(ctx.auth.tenantId)))
            .orderBy(desc(aiUsageLedger.createdAt))
            .limit(100),
        ),
    }),
    flags: permissionProcedure("system.flags.read").query(({ ctx }) =>
      deps.db
        .select()
        .from(featureFlags)
        .where(eq(featureFlags.tenantId, Number(ctx.auth.tenantId)))
        .limit(100),
    ),
    policies: permissionProcedure("system.policies.read").query(({ ctx }) =>
      deps.db
        .select()
        .from(automationPolicies)
        .where(eq(automationPolicies.tenantId, Number(ctx.auth.tenantId)))
        .limit(100),
    ),
  });
}
