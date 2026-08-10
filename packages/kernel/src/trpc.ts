import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { AuthContext, Permission } from "@xmaster-center/contracts";
import { can } from "./rbac.js";

export type TrpcContext = {
  auth: AuthContext | null;
};

const t = initTRPC.context<TrpcContext>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.auth)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Anmeldung erforderlich",
    });
  return next({ ctx: { ...ctx, auth: ctx.auth } });
});

export function permissionProcedure(permission: Permission) {
  return protectedProcedure.use(({ ctx, next }) => {
    if (!ctx.auth || !can(ctx.auth, permission)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Berechtigung erforderlich",
        cause: { permission },
      });
    }
    return next();
  });
}

export type AppRouter = ReturnType<typeof router>;
