import { createHash } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

import type { AuthProvider, AuthRequest, ResolvedIdentity } from "./types.js";

export type LocalIdentity = {
  userId: string;
  tenantId: string;
  email: string | null;
  displayName: string;
  rolePermissions: string[];
};

export type LocalAuthOptions = {
  secret: Uint8Array;
  expiry?: string;
  cookieName?: string;
  findIdentity(userId: string): Promise<LocalIdentity | null>;
};

export function hashSecret(secret: string, pepper: string): string {
  return createHash("sha256")
    .update(`${secret}${pepper}`, "utf8")
    .digest("hex");
}

export function createLocalProvider(options: LocalAuthOptions): AuthProvider & {
  signSession(identity: LocalIdentity): Promise<string>;
} {
  const cookieName = options.cookieName ?? "xmc_session";
  return {
    name: "local",
    async signSession(identity) {
      return new SignJWT({ sub: identity.userId, tenantId: identity.tenantId })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(options.expiry ?? "8h")
        .sign(options.secret);
    },
    async resolve(request: AuthRequest): Promise<ResolvedIdentity | null> {
      const bearer = request.headers.authorization
        ?.toString()
        .replace(/^Bearer\s+/i, "");
      const token = request.cookies?.[cookieName] ?? bearer;
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, options.secret);
        const userId = String(payload.sub ?? "");
        const tenantId = String(payload.tenantId ?? "");
        if (!userId || !tenantId) return null;
        const identity = await options.findIdentity(userId);
        if (!identity || identity.tenantId !== tenantId) return null;
        return {
          user: {
            id: identity.userId,
            email: identity.email,
            displayName: identity.displayName,
          },
          tenantId,
          permissions: new Set(identity.rolePermissions),
          provider: "local",
        };
      } catch {
        return null;
      }
    },
  };
}
