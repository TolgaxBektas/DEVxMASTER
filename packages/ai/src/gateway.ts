import { AiError } from "./errors.js";
import { requireApprovedPrompt } from "./prompts.js";
import type {
  AiProvider,
  Budget,
  ChatOutput,
  ContentAnchor,
  UsageLedger,
} from "./types.js";
import type { PromptRepository } from "./prompts.js";

export type GatewayOptions = {
  providers: { get(name: string): AiProvider };
  prompts: PromptRepository;
  ledger: UsageLedger;
  now?: () => Date;
};

export class AiGateway {
  private readonly now: () => Date;
  constructor(private readonly options: GatewayOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async chat(input: {
    tenantId: string;
    provider: string;
    model: string;
    promptKey: string;
    promptVersion?: string;
    variables?: Record<string, string>;
    userText: string;
    budget?: Budget;
    objectType?: string;
    objectId?: string;
    anchors?: readonly ContentAnchor[];
  }): Promise<ChatOutput> {
    const prompt = await requireApprovedPrompt(
      this.options.prompts,
      input.promptKey,
      input.promptVersion,
    );
    const system = Object.entries(input.variables ?? {}).reduce(
      (body, [key, value]) => body.replaceAll(`{{${key}}}`, value),
      prompt.body,
    );
    const provider = this.options.providers.get(input.provider);
    const result = await provider.chat({
      model: input.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: input.userText },
      ],
    });
    if (input.budget)
      await this.assertBudget(input.budget, result.usage.costMicros);
    if (input.anchors) {
      const { validateContentAnchors } = await import("./anchors.js");
      validateContentAnchors(result.text, input.anchors);
    }
    const ledgerEntry = {
      tenantId: input.tenantId,
      provider: provider.name,
      model: input.model,
      operation: "chat",
      usage: result.usage,
      ...(input.objectType ? { objectType: input.objectType } : {}),
      ...(input.objectId ? { objectId: input.objectId } : {}),
    };
    await this.options.ledger.record(ledgerEntry);
    return result;
  }

  private async assertBudget(budget: Budget, nextCost: number) {
    const current = await this.options.ledger.totalCost(
      budget.tenantId,
      budget.objectId,
    );
    if (current + nextCost > budget.maxCostMicros) {
      throw new AiError(
        "BUDGET_EXCEEDED",
        "KI-Budget überschritten; Vorgang wurde abgebrochen",
      );
    }
  }
}
