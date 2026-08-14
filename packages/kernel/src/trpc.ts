import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { AuthContext, Permission } from "@xmaster-center/contracts";
import { can } from "./rbac.js";

export { TRPCError } from "@trpc/server";

export type TrpcContext = {
  auth: AuthContext | null;
};

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const validationMessage = error.cause instanceof ZodError
      ? error.cause.issues.map((issue) => {
          const path = issue.path.join(".");
          return path ? `${path}: ${issue.message}` : issue.message;
        }).join(" ")
      : null;
    return {
      ...shape,
      message: error.code === "INTERNAL_SERVER_ERROR"
        ? "Interner Serverfehler"
        : validationMessage ?? shape.message,
    };
  },
});

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
    return next({ ctx: { ...ctx, auth: ctx.auth } });
  });
}

export type AppRouter = ReturnType<
  typeof router<{ modules: import("@trpc/server").AnyRouter }>
>;
export type ClientRouter = ReturnType<typeof router<{}>>;
