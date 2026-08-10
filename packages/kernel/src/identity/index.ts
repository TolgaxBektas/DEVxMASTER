import type { AuthContext } from "@xmaster-center/contracts";

import { toAuthContext, type AuthProvider, type AuthRequest } from "./types.js";

export * from "./types.js";
export * from "./local.js";
export * from "./oauth.js";
export * from "./token.js";

export async function resolveSession(
  request: AuthRequest,
  dependencies: { providers: AuthProvider[] },
): Promise<AuthContext | null> {
  for (const provider of dependencies.providers) {
    const identity = await provider.resolve(request);
    if (identity) return toAuthContext(identity);
  }
  return null;
}
