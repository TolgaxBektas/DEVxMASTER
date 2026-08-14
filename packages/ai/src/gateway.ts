import { validateContentAnchors } from "./anchors.js";
import {
  evaluateAutomation,
  type AutomationPolicyRepository,
} from "./automation.js";
import { AiError } from "./errors.js";
import { requireApprovedPrompt, type PromptRepository } from "./prompts.js";
import type {
  AiProvider,
  Budget,
  ChatOutput,
  ContentAnchor,
  ImageOutput,
  TranscribeOutput,
  Usage,
  UsageLedger,
} from "./types.js";

export type GatewayOptions = {
  providers: { get(name: string): AiProvider };
  prompts: PromptRepository;
  ledger: UsageLedger;
  policies?: AutomationPolicyRepository;
  now?: () => Date;
};

type CommonInput = {
  tenantId: string;
  provider: string;
  model: string;
  promptKey: string;
  promptVersion?: string;
  variables?: Record<string, string>;
  budget?: Budget;
  objectType?: string;
  objectId?: string;
  anchors?: readonly ContentAnchor[];
  operation?: string;
};

export class AiGateway {
  private readonly now: () => Date;

  constructor(private readonly options: GatewayOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async chat(input: CommonInput & { userText: string }): Promise<ChatOutput> {
    const prompt = await this.prepare(input);
    await this.assertBudgetBefore(input.budget);
    const result = await this.options.providers.get(input.provider).chat({
      model: input.model,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: input.userText },
      ],
    });
    await this.finalize(input, "chat", result.usage);
    if (input.anchors) validateContentAnchors(result.text, input.anchors);
    return result;
  }

  async vision(
    input: CommonInput & { imageUrl: string; userText: string },
  ): Promise<ChatOutput> {
    const prompt = await this.prepare(input);
    await this.assertBudgetBefore(input.budget);
    const result = await this.options.providers.get(input.provider).vision({
      model: input.model,
      imageUrl: input.imageUrl,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: input.userText },
      ],
    });
    await this.finalize(input, "vision", result.usage);
    if (input.anchors) validateContentAnchors(result.text, input.anchors);
    return result;
  }

  async image(input: CommonInput & { size?: string }): Promise<ImageOutput> {
    const prompt = await this.prepare(input);
    await this.assertBudgetBefore(input.budget);
    const result = await this.options.providers.get(input.provider).image({
      model: input.model,
      prompt,
      ...(input.size ? { size: input.size } : {}),
    });
    await this.finalize(input, "image", result.usage);
    return result;
  }

  async transcribe(
    input: CommonInput & { audio: Uint8Array; filename?: string },
  ): Promise<TranscribeOutput> {
    await this.prepare(input);
    await this.assertBudgetBefore(input.budget);
    const result = await this.options.providers.get(input.provider).transcribe({
      model: input.model,
      audio: input.audio,
      ...(input.filename ? { filename: input.filename } : {}),
    });
    await this.finalize(input, "transcribe", result.usage);
    if (input.anchors) validateContentAnchors(result.text, input.anchors);
    return result;
  }

  private async prepare(input: CommonInput) {
    if (this.options.policies && input.operation) {
      const mode = await evaluateAutomation(this.options.policies, {
        tenantId: input.tenantId,
        operation: input.operation,
      });
      if (mode === "human_required") {
        throw new AiError(
          "HUMAN_APPROVAL_REQUIRED",
          "Menschliche Freigabe ist erforderlich",
        );
      }
    }
    const prompt = await requireApprovedPrompt(
      this.options.prompts,
      input.promptKey,
      input.promptVersion,
    );
    return Object.entries(input.variables ?? {}).reduce(
      (body, [key, value]) => body.replaceAll(`{{${key}}}`, value),
      prompt.body,
    );
  }

  private async assertBudgetBefore(budget?: Budget) {
    if (!budget) return;
    const current = await this.options.ledger.totalCost(
      budget.tenantId,
      budget.objectId,
    );
    if (current >= budget.maxCostMicros) {
      throw new AiError(
        "BUDGET_EXCEEDED",
        "KI-Budget vor Provideraufruf überschritten",
      );
    }
  }

  private async finalize(input: CommonInput, operation: string, usage: Usage) {
    await this.options.ledger.record({
      tenantId: input.tenantId,
      provider: input.provider,
      model: input.model,
      operation,
      usage,
      ...(input.objectType ? { objectType: input.objectType } : {}),
      ...(input.objectId ? { objectId: input.objectId } : {}),
    });
    if (input.budget) {
      const total = await this.options.ledger.totalCost(
        input.budget.tenantId,
        input.budget.objectId,
      );
      if (total > input.budget.maxCostMicros) {
        throw new AiError(
          "BUDGET_EXCEEDED",
          "KI-Budget nach Provideraufruf überschritten",
        );
      }
    }
  }
}
