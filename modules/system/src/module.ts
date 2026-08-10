import { defineModule, type ModuleDefinition } from "@xmaster-center/kernel";
import { createSystemRouter } from "./router.js";
import type { EventRepository } from "@xmaster-center/kernel";
import type { LeaseQueue } from "@xmaster-center/jobs";
import { systemPages, SystemPage } from "./ui/index.js";

export { systemPages } from "./ui/index.js";

export function createSystemModule(deps: {
  db: any;
  audit: any;
  events: EventRepository;
  queue: LeaseQueue;
  health(): Promise<unknown>;
  navigation(permissions: ReadonlySet<string>): unknown[];
}): ModuleDefinition {
  return defineModule({
    id: "system",
    title: "Betrieb",
    icon: "settings",
    version: "0.1.0",
    schema: {},
    router: createSystemRouter(deps),
    nav: [
      {
        id: "system.audit",
        label: "Audit",
        href: "/system/audit",
        permission: "system.audit.read",
        order: 10,
      },
      {
        id: "system.jobs",
        label: "Jobs",
        href: "/system/jobs",
        permission: "system.jobs.read",
        order: 20,
      },
      {
        id: "system.ai",
        label: "KI-Kosten",
        href: "/system/ai",
        permission: "system.ai.read",
        order: 30,
      },
      {
        id: "system.modules",
        label: "Module",
        href: "/system/modules",
        permission: "system.health.read",
        order: 40,
      },
      {
        id: "system.flags",
        label: "Feature Flags",
        href: "/system/flags",
        permission: "system.flags.read",
        order: 50,
      },
      {
        id: "system.policies",
        label: "Automations-Policies",
        href: "/system/policies",
        permission: "system.policies.read",
        order: 60,
      },
    ],
    pages: systemPages.map(([id, title, path, permission]) => ({
      id,
      title,
      path,
      permission,
      component: SystemPage,
    })),
    permissions: [
      { permission: "system.health.read", title: "Betriebsstatus lesen" },
      { permission: "system.audit.read", title: "Audit lesen" },
      { permission: "system.jobs.read", title: "Jobs lesen" },
      { permission: "system.jobs.requeue", title: "Jobs erneut einreihen" },
      { permission: "system.events.read", title: "Ereignisse lesen" },
      { permission: "system.events.requeue", title: "Ereignisse erneut zustellen" },
      { permission: "system.ai.read", title: "KI-Kosten lesen" },
      { permission: "system.flags.read", title: "Feature Flags lesen" },
      {
        permission: "system.policies.read",
        title: "Automations-Policies lesen",
      },
    ],
    jobs: [],
    events: [],
    health: () => ({ id: "system", status: "healthy" }),
  });
}
