import type {
  AuthContext,
  AuthProviderName,
  Permission,
  TenantId,
  User,
} from "@xmaster-center/contracts";

export type AuthRequest = {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
  query?: Record<string, string | undefined>;
};

export type AuthProvider = {
  name: AuthProviderName;
  resolve(request: AuthRequest): Promise<ResolvedIdentity | null>;
};

export type ResolvedIdentity = {
  user: User;
  tenantId: TenantId;
  permissions: ReadonlySet<Permission>;
  provider: AuthProviderName;
  tokenId?: string;
};

export type IdentityDependencies = {
  providers: AuthProvider[];
  resolvePermissions(
    userId: string,
    tenantId: TenantId,
  ): Promise<ReadonlySet<Permission>>;
};

export function toAuthContext(identity: ResolvedIdentity): AuthContext {
  return {
    user: identity.user,
    tenantId: identity.tenantId,
    permissions: identity.permissions,
    provider: identity.provider,
    ...(identity.tokenId ? { tokenId: identity.tokenId } : {}),
  };
}
