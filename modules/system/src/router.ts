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
      list: permissionProcedure("system.audit.read").query(() =>
        deps.db.select().from(auditLog).orderBy(desc(auditLog.seq)).limit(100),
      ),
      verify: permissionProcedure("system.audit.read").query(() =>
        verifyAuditChain(deps.audit),
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
            throw new Error("Job nicht gefunden");
          }
          const job = await deps.queue.requeue(input.id);
          if (!job) throw new Error("Job nicht gefunden");
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
          if (!current) throw new Error("Event nicht gefunden");
          const event = await deps.events.requeue(input.id);
          if (!event) throw new Error("Event nicht gefunden");
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
        .input(
          z
            .object({
              tenantId: z.number().int().positive().optional(),
            })
            .optional(),
        )
        .query(({ input }) => {
          const query = deps.db
            .select()
            .from(aiUsageLedger)
            .orderBy(desc(aiUsageLedger.createdAt))
            .limit(100);
          return input?.tenantId
            ? query.where(eq(aiUsageLedger.tenantId, input.tenantId))
            : query;
        }),
    }),
    flags: permissionProcedure("system.flags.read").query(() =>
      deps.db.select().from(featureFlags).limit(100),
    ),
    policies: permissionProcedure("system.policies.read").query(() =>
      deps.db.select().from(automationPolicies).limit(100),
    ),
  });
}
