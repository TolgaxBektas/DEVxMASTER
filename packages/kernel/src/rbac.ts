import type {
  AuthContext,
  Permission,
  TenantId,
} from "@xmaster-center/contracts";

export type PermissionDefinition = {
  permission: Permission;
  title?: string;
};

export class PermissionRegistry {
  private readonly definitions = new Map<Permission, PermissionDefinition>();

  register(definitions: PermissionDefinition[]): void {
    for (const definition of definitions) {
      if (this.definitions.has(definition.permission)) {
        throw new Error(
          `Permission bereits registriert: ${definition.permission}`,
        );
      }
      this.definitions.set(definition.permission, definition);
    }
  }

  has(permission: Permission): boolean {
    return this.definitions.has(permission);
  }

  all(): PermissionDefinition[] {
    return [...this.definitions.values()];
  }
}

export function can(
  context: AuthContext,
  permission: Permission,
  resourceTenantId?: TenantId,
): boolean {
  if (resourceTenantId && resourceTenantId !== context.tenantId) return false;
  return context.permissions.has(permission);
}

export type TenantScope = {
  tenantId: TenantId;
  where<T>(tenantColumn: T): { tenantColumn: T; tenantId: TenantId };
};

export function tenantScope(
  context: Pick<AuthContext, "tenantId">,
): TenantScope {
  return {
    tenantId: context.tenantId,
    where<T>(tenantColumn: T) {
      return { tenantColumn, tenantId: context.tenantId };
    },
  };
}
