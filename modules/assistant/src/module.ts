import { defineModule, type ModuleDefinition } from "@xmaster-center/kernel";
import { createAssistantRouter, type AssistantDeps } from "./router.js";
import { assistantPages, AssistantPage } from "./ui/index.js";
export function createAssistantModule(deps: AssistantDeps): ModuleDefinition {
  return defineModule({
    id: "assistant", title: "ALEXIS", icon: "sparkles", version: "0.1.0", schema: {},
    router: createAssistantRouter(deps),
    nav: [{ id: "assistant.briefing", label: "ALEXIS", href: "/assistant", permission: "assistant.briefing.read", order: 10 }],
    pages: assistantPages.map(([id, title, path, permission]) => ({ id, title, path, permission, component: AssistantPage })),
    permissions: [
      { permission: "assistant.briefing.read", title: "ALEXIS-Briefing lesen" },
      { permission: "assistant.chat", title: "ALEXIS-Chat" },
      { permission: "assistant.proposal.read", title: "ALEXIS-Vorschläge lesen" },
      { permission: "assistant.proposal.approve", title: "ALEXIS-Vorschläge freigeben" },
      { permission: "assistant.proposal.execute", title: "ALEXIS-Vorschläge ausführen" },
    ],
    jobs: [], events: [], health: () => ({ id: "assistant", status: "healthy" }),
  });
}
