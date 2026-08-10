import { describe, expect, it } from "vitest";
import type { AuthContext } from "@xmaster-center/contracts";
import { createAssistantRouter } from "./router.js";

const context: AuthContext = {
  user: { id: "1", email: "admin@example.invalid", displayName: "Admin" },
  tenantId: "1",
  permissions: new Set([
    "assistant.proposal.read",
    "assistant.proposal.approve",
    "assistant.proposal.execute",
  ]),
  provider: "local",
};

function setup(policy: "automatic" | "suggestion" | "human_required" | null = null) {
  const audit: string[] = [];
  const caller = createAssistantRouter({
    briefing: async () => ({}),
    chat: async () => "ok",
    policy: async () => policy,
    audit: async ({ action }) => { audit.push(action); },
  }).createCaller({ auth: context });
  return { caller, audit };
}

describe("ALEXIS-Automationsrichtlinie", () => {
  it("liefert die Policy-Einstufung", async () => {
    expect((await setup("automatic").caller.proposals.approve({ id: "review-lead" })).state).toBe("automatic");
    expect((await setup("suggestion").caller.proposals.approve({ id: "review-lead" })).state).toBe("suggestion");
    expect((await setup().caller.proposals.approve({ id: "review-lead" })).state).toBe("human_required");
  });

  it("führt einen freigabepflichtigen Vorschlag nicht ohne Freigabe aus", async () => {
    const { caller } = setup("human_required");
    await expect(caller.proposals.execute({ id: "review-lead" })).rejects.toThrow("freigegeben");
    await caller.proposals.approve({ id: "review-lead" });
    await expect(caller.proposals.execute({ id: "review-lead" })).resolves.toMatchObject({ state: "executed" });
  });

  it("respektiert die Rechte des Handelnden", async () => {
    const { caller } = setup("human_required");
    context.permissions = new Set(["assistant.proposal.read"]);
    await expect(caller.proposals.approve({ id: "review-lead" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    context.permissions = new Set(["assistant.proposal.read", "assistant.proposal.approve", "assistant.proposal.execute"]);
  });
});
