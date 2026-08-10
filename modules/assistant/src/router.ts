import { permissionProcedure, router } from "@xmaster-center/kernel";
import { z } from "zod";

export type AssistantDeps = {
  briefing(tenantId: string): Promise<Record<string, unknown>>;
  chat(tenantId: string, text: string): Promise<string>;
  audit(input: { tenantId: string; action: string; entityId: string; details: Record<string, unknown> }): Promise<void>;
};
export function createAssistantRouter(deps: AssistantDeps) {
  return router({
    briefing: permissionProcedure("assistant.briefing.read").query(({ ctx }) =>
      deps.briefing(ctx.auth.tenantId),
    ),
    chat: permissionProcedure("assistant.chat").input(z.object({ text: z.string().min(1) })).mutation(({ ctx, input }) =>
      deps.chat(ctx.auth.tenantId, input.text),
    ),
    proposals: router({
      list: permissionProcedure("assistant.proposal.read").query(() => [
        { id: "review-lead", title: "Neuen Lead aus Fundstelle prüfen", state: "approval_required" },
      ]),
      approve: permissionProcedure("assistant.proposal.approve")
        .input(z.object({ id: z.string() }))
        .mutation(async ({ ctx, input }) => {
          await deps.audit({ tenantId: ctx.auth.tenantId, action: "assistant.proposal.approved", entityId: input.id, details: { proposalId: input.id } });
          return { id: input.id, state: "approved" };
        }),
      execute: permissionProcedure("assistant.proposal.execute")
        .input(z.object({ id: z.string() }))
        .mutation(async ({ ctx, input }) => {
          await deps.audit({ tenantId: ctx.auth.tenantId, action: "assistant.proposal.executed", entityId: input.id, details: { proposalId: input.id } });
          return { id: input.id, state: "executed" };
        }),
    }),
  });
}
