import { permissionProcedure, router } from "@xmaster-center/kernel";
import { evaluateAutomation, type AutomationMode } from "@xmaster-center/ai";
import { z } from "zod";

export type AssistantDeps = {
  briefing(tenantId: string): Promise<Record<string, unknown>>;
  chat(tenantId: string, text: string): Promise<string>;
  audit(input: { tenantId: string; action: string; entityId: string; details: Record<string, unknown> }): Promise<void>;
  policy?: (tenantId: string, operation: string) => Promise<AutomationMode | null>;
};
export function createAssistantRouter(deps: AssistantDeps) {
  const states = new Map<string, "suggestion" | "approved" | "executed">();
  const modeFor = (tenantId: string) =>
    evaluateAutomation(
      {
        mode: async (policyTenantId, operation) =>
          deps.policy?.(policyTenantId, operation) ?? null,
      },
      { tenantId, operation: "review-lead" },
    );
  return router({
    briefing: permissionProcedure("assistant.briefing.read").query(({ ctx }) =>
      deps.briefing(ctx.auth.tenantId),
    ),
    chat: permissionProcedure("assistant.chat").input(z.object({ text: z.string().min(1) })).mutation(({ ctx, input }) =>
      deps.chat(ctx.auth.tenantId, input.text),
    ),
    proposals: router({
      list: permissionProcedure("assistant.proposal.read").query(async ({ ctx }) => {
        const mode = await modeFor(ctx.auth.tenantId);
        return [
          {
            id: "review-lead",
            title: "Neuen Lead aus Fundstelle prüfen",
            state: states.get("review-lead") ?? "approval_required",
            policy: mode,
          },
        ];
      }),
      approve: permissionProcedure("assistant.proposal.approve")
        .input(z.object({ id: z.string() }))
        .mutation(async ({ ctx, input }) => {
          const mode = await modeFor(ctx.auth.tenantId);
          states.set(input.id, "approved");
          await deps.audit({ tenantId: ctx.auth.tenantId, action: "assistant.proposal.approved", entityId: input.id, details: { proposalId: input.id } });
          return { id: input.id, state: mode };
        }),
      execute: permissionProcedure("assistant.proposal.execute")
        .input(z.object({ id: z.string() }))
        .mutation(async ({ ctx, input }) => {
          if (states.get(input.id) !== "approved")
            throw new Error("Vorschlag muss zuerst freigegeben werden");
          states.set(input.id, "executed");
          await deps.audit({ tenantId: ctx.auth.tenantId, action: "assistant.proposal.executed", entityId: input.id, details: { proposalId: input.id } });
          return { id: input.id, state: "executed" };
        }),
    }),
  });
}
