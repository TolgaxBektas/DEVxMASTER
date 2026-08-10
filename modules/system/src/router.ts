import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  aiUsageLedger,
  auditLog,
  automationPolicies,
  featureFlags,
  jobs,
  permissionProcedure,
  router,
  verifyAuditChain,
  type AuditRepository,
} from "@xmaster-center/kernel";

export function createSystemRouter(deps: {
  db: any;
  audit: AuditRepository;
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
    audit: router({
      list: permissionProcedure("system.audit.read").query(() =>
        deps.db.select().from(auditLog).orderBy(desc(auditLog.seq)).limit(100),
      ),
      verify: permissionProcedure("system.audit.read").query(() =>
        verifyAuditChain(deps.audit),
      ),
    }),
    jobs: router({
      list: permissionProcedure("system.jobs.read").query(() =>
        deps.db.select().from(jobs).orderBy(desc(jobs.updatedAt)).limit(100),
      ),
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
