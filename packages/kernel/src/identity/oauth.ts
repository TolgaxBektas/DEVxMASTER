import type { AuthProvider, AuthRequest, ResolvedIdentity } from "./types.js";

export type OAuthProfile = {
  externalId: string;
  email: string | null;
  displayName: string;
  tenantId: string;
  userId: string;
};

export type OAuthOptions = {
  resolveAuthorizationCode(code: string): Promise<OAuthProfile | null>;
  codeQueryKey?: string;
};

export function createOAuthProvider(options: OAuthOptions): AuthProvider {
  const codeQueryKey = options.codeQueryKey ?? "code";
  return {
    name: "oauth",
    async resolve(request: AuthRequest): Promise<ResolvedIdentity | null> {
      const code = request.query?.[codeQueryKey];
      if (!code) return null;
      const profile = await options.resolveAuthorizationCode(code);
      if (!profile) return null;
      return {
        user: {
          id: profile.userId,
          email: profile.email,
          displayName: profile.displayName,
        },
        tenantId: profile.tenantId,
        permissions: new Set(),
        provider: "oauth",
      };
    },
  };
}
