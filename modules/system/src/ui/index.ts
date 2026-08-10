export { SystemPage } from "./SystemPage.js";

export const systemPages = [
  ["system.overview", "Betrieb", "/system", "system.health.read"],
  ["system.modules", "Module", "/system/modules", "system.health.read"],
  ["system.audit", "Audit", "/system/audit", "system.audit.read"],
  ["system.jobs", "Jobs", "/system/jobs", "system.jobs.read"],
  ["system.ai", "KI-Kosten", "/system/ai", "system.ai.read"],
  ["system.flags", "Feature Flags", "/system/flags", "system.flags.read"],
  [
    "system.policies",
    "Automations-Policies",
    "/system/policies",
    "system.policies.read",
  ],
] as const;
