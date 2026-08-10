import type { Express } from "express";
import type { Permission } from "@xmaster-center/contracts";
import { PermissionRegistry, type PermissionDefinition } from "./rbac.js";

export type NavEntry = {
  id: string;
  label: string;
  href: string;
  icon?: string;
  permission?: Permission;
};

export type ModuleHealth = {
  id: string;
  status: "healthy" | "degraded" | "down";
  details?: Record<string, unknown>;
};

export type ModuleJob = {
  name: string;
  handle: (payload: unknown, context: unknown) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
  schedule?: string;
};

export type ModuleEvent = {
  name: string;
  direction: "published" | "subscribed";
  handle?: (event: unknown) => Promise<void>;
};

export type ModuleDefinition = {
  id: string;
  title: string;
  icon: string;
  version: string;
  schema: Record<string, unknown>;
  router: unknown;
  rest?: (app: Express) => void;
  nav: readonly NavEntry[];
  permissions: readonly (PermissionDefinition | Permission)[];
  jobs: readonly ModuleJob[];
  events: readonly ModuleEvent[];
  health(): Promise<ModuleHealth> | ModuleHealth;
};

export function defineModule(definition: ModuleDefinition): ModuleDefinition {
  if (!/^[a-z][a-z0-9-]*$/.test(definition.id))
    throw new Error(`Ungültige Modul-ID: ${definition.id}`);
  return Object.freeze({ ...definition });
}

export function createRegistry(modules: readonly ModuleDefinition[]) {
  const ids = new Set<string>();
  const permissionRegistry = new PermissionRegistry();
  const jobs = new Map<string, ModuleJob>();
  const events = new Map<string, ModuleEvent[]>();
  for (const module of modules) {
    if (ids.has(module.id))
      throw new Error(`Modul-ID bereits registriert: ${module.id}`);
    ids.add(module.id);
    permissionRegistry.register(
      module.permissions.map((permission) =>
        typeof permission === "string" ? { permission } : permission,
      ),
    );
    for (const job of module.jobs) {
      if (jobs.has(job.name))
        throw new Error(`Job bereits registriert: ${job.name}`);
      jobs.set(job.name, job);
    }
    for (const event of module.events) {
      const list = events.get(event.name) ?? [];
      list.push(event);
      events.set(event.name, list);
    }
  }
  const routers = Object.fromEntries(
    modules.map((module) => [module.id, module.router]),
  );
  return {
    modules: [...modules],
    router: { modules: routers },
    permissions: permissionRegistry,
    jobs,
    events,
    navigation(context: { permissions: ReadonlySet<string> }) {
      return modules
        .flatMap((module) => module.nav)
        .filter(
          (item) =>
            !item.permission || context.permissions.has(item.permission),
        );
    },
    async health(): Promise<ModuleHealth[]> {
      return Promise.all(modules.map((module) => module.health()));
    },
  };
}
