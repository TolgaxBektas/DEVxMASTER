import { describe, expect, it } from "vitest";
import { AiError } from "./errors.js";
import { AiGateway } from "./gateway.js";
import { runJury } from "./jury.js";
import { MemoryPromptRepository } from "./prompts.js";
import { MockProvider } from "./providers.js";
import type { Usage, UsageLedger } from "./types.js";

class Ledger implements UsageLedger {
  readonly entries: Array<{
    tenantId: string;
    usage: Usage;
    objectId?: string;
  }> = [];
  async record(input: { tenantId: string; usage: Usage; objectId?: string }) {
    this.entries.push(input);
  }
  async totalCost(tenantId: string, objectId?: string) {
    return this.entries
      .filter(
        (item) => item.tenantId === tenantId && item.objectId === objectId,
      )
      .reduce((sum, item) => sum + item.usage.costMicros, 0);
  }
}

describe("LLM-Gateway", () => {
  it("blockiert nicht freigegebene Prompts, Budgets und Anchor-Verstöße", async () => {
    const prompts = new MemoryPromptRepository();
    prompts.add({
      key: "test",
      version: "1",
      body: "Nenne {{fact}}",
      status: "draft",
    });
    const ledger = new Ledger();
    const gateway = new AiGateway({
      providers: { get: () => new MockProvider("Firma") },
      prompts,
      ledger,
    });
    await expect(
      gateway.chat({
        tenantId: "t1",
        provider: "mock",
        model: "test",
        promptKey: "test",
        variables: { fact: "Fakten" },
        userText: "x",
      }),
    ).rejects.toMatchObject({ code: "PROMPT_NOT_APPROVED" });
    prompts.add({
      key: "test",
      version: "2",
      body: "Nenne Fakten",
      status: "approved",
    });
    await expect(
      gateway.chat({
        tenantId: "t1",
        provider: "mock",
        model: "test",
        promptKey: "test",
        userText: "x",
        budget: { tenantId: "t1", maxCostMicros: -1 },
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await expect(
      gateway.chat({
        tenantId: "t1",
        provider: "mock",
        model: "test",
        promptKey: "test",
        userText: "x",
        anchors: [{ key: "phone", value: "999", category: "phone" }],
      }),
    ).rejects.toMatchObject({ code: "CONTENT_ANCHOR_VIOLATION" });
  });
  it("wählt die beste Variante, gibt aber alle zurück", async () => {
    const good = new MockProvider("good");
    const bad = new MockProvider("bad");
    const result = await runJury(
      [good, bad],
      { model: "x", messages: [] },
      (item) => (item.text === "good" ? 10 : 1),
    );
    expect(result.best.provider).toBe("mock");
    expect(result.variants).toHaveLength(2);
  });
});
