export type AutomationMode = "automatic" | "suggestion" | "human_required";
export type AutomationPolicyRepository = {
  mode(tenantId: string, operation: string): Promise<AutomationMode | null>;
};

export async function evaluateAutomation(
  repository: AutomationPolicyRepository,
  input: { tenantId: string; operation: string },
): Promise<AutomationMode> {
  return (
    (await repository.mode(input.tenantId, input.operation)) ?? "human_required"
  );
}
