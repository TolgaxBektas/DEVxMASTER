import { createHash, timingSafeEqual } from "node:crypto";

import type { AuthProvider, AuthRequest, ResolvedIdentity } from "./types.js";

export type TokenRecord = {
  id: string;
  tokenHash: string;
  userId: string;
  tenantId: string;
  email: string | null;
  displayName: string;
  scopes: string[];
  expiresAt: Date | null;
};

export type TokenOptions = {
  findToken(hash: string): Promise<TokenRecord | null>;
  headerName?: string;
};

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createTokenProvider(options: TokenOptions): AuthProvider {
  const headerName = (options.headerName ?? "x-portal-token").toLowerCase();
  return {
    name: "token",
    async resolve(request: AuthRequest): Promise<ResolvedIdentity | null> {
      const raw = request.headers[headerName]?.toString();
      if (!raw) return null;
      const record = await options.findToken(hashOpaqueToken(raw));
      if (!record || (record.expiresAt && record.expiresAt <= new Date()))
        return null;
      if (
        !timingSafeEqual(
          Buffer.from(record.tokenHash),
          Buffer.from(hashOpaqueToken(raw)),
        )
      )
        return null;
      return {
        user: {
          id: record.userId,
          email: record.email,
          displayName: record.displayName,
        },
        tenantId: record.tenantId,
        permissions: new Set(record.scopes),
        provider: "token",
        tokenId: record.id,
      };
    },
  };
}
