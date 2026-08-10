import type { Express } from "express";
import { router as createTrpcRouter } from "./trpc.js";
import type { AnyRouter } from "@trpc/server";
import type { Permission } from "@xmaster-center/contracts";
import { PermissionRegistry, type PermissionDefinition } from "./rbac.js";

export type NavEntry = {
  id: string;
  label: string;
  href: string;
  icon?: string;
  permission?: Permission;
  order?: number;
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

export type ModulePage = {
  id: string;
  title: string;
  path: string;
  permission?: Permission;
  component: unknown;
};

export type ModuleDefinition = {
  id: string;
  title: string;
  icon: string;
  version: string;
  schema: Record<string, unknown>;
  router: AnyRouter;
  rest?: (app: Express) => void;
  nav: readonly NavEntry[];
  pages: readonly ModulePage[];
  permissions: readonly (PermissionDefinition | Permission)[];
  jobs: readonly ModuleJob[];
  events: readonly ModuleEvent[];
  health(): Promise<ModuleHealth> | ModuleHealth;
};

export function defineModule(definition: ModuleDefinition): ModuleDefinition {
  if (!/^[a-z][a-z0-9-]*$/.test(definition.id)) {
    throw new Error(`Ungültige Modul-ID: ${definition.id}`);
  }
  return Object.freeze({ ...definition });
}

function mergeSchemas(modules: readonly ModuleDefinition[]) {
  const schema: Record<string, unknown> = {};
  for (const module of modules) {
    for (const [key, table] of Object.entries(module.schema)) {
      const tableName = drizzleTableName(table) ?? key;
      if (schema[tableName]) {
        throw new Error(`Tabelle bereits registriert: ${tableName}`);
      }
      schema[tableName] = table;
    }
  }
  return schema;
}

function drizzleTableName(table: unknown): string | null {
  if (!table || typeof table !== "object") return null;
  const symbol = Object.getOwnPropertySymbols(table).find((item) =>
    item.description?.toLowerCase().includes("name"),
  );
  const value = symbol ? (table as Record<symbol, unknown>)[symbol] : undefined;
  return typeof value === "string" ? value : null;
}

export function createRegistry(modules: readonly ModuleDefinition[]) {
  const ids = new Set<string>();
  const permissionRegistry = new PermissionRegistry();
  const jobs = new Map<string, ModuleJob>();
  const events = new Map<string, ModuleEvent[]>();
  for (const module of modules) {
    if (ids.has(module.id)) {
      throw new Error(`Modul-ID bereits registriert: ${module.id}`);
    }
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
  const rootRouter = createTrpcRouter({ modules: routers });
  return {
    modules: [...modules],
    schema: mergeSchemas(modules),
    router: rootRouter,
    permissions: permissionRegistry,
    jobs,
    events,
    pages: modules.flatMap((module) =>
      module.pages.map((page) => ({ ...page, moduleId: module.id })),
    ),
    rest(app: Express) {
      for (const module of modules) module.rest?.(app);
    },
    navigation(context: { permissions: ReadonlySet<string> }) {
      return modules
        .flatMap((module) =>
          module.nav
            .filter(
              (item) =>
                !item.permission || context.permissions.has(item.permission),
            )
            .map((item) => ({
              ...item,
              moduleId: module.id,
              moduleTitle: module.title,
            })),
        )
        .sort(
          (a, b) =>
            a.moduleId.localeCompare(b.moduleId) ||
            (a.order ?? 0) - (b.order ?? 0) ||
            a.label.localeCompare(b.label, "de"),
        );
    },
    async health(): Promise<ModuleHealth[]> {
      return Promise.all(modules.map((module) => module.health()));
    },
  };
}

export type ModuleRegistry = ReturnType<typeof createRegistry>;
