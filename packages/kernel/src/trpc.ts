import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { AuthContext, Permission } from "@xmaster-center/contracts";
import { can } from "./rbac.js";

export { TRPCError } from "@trpc/server";

export type TrpcContext = {
  auth: AuthContext | null;
};

function formatValidationMessage(message: string): string | null {
  try {
    const parsed: unknown = JSON.parse(message);
    if (!Array.isArray(parsed)) return null;
    const messages = parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const issue = item as { path?: unknown; message?: unknown };
      if (typeof issue.message !== "string") return [];
      const path = Array.isArray(issue.path)
        ? formatValidationPath(issue.path)
        : "";
      return [path ? `${path}: ${issue.message}` : issue.message];
    });
    return messages.length ? messages.join(" ") : null;
  } catch {
    return null;
  }
}

const fieldLabels: Record<string, string> = {
  type: "Art",
  publicationName: "Publikationsname",
  editionLabel: "Ausgabe",
  periodStartYear: "Startjahr",
  periodEndYear: "Endjahr",
  periodIssue: "Ausgabennummer",
  regionPlace: "Ort",
  regionDistrict: "Kreis",
  regionState: "Bundesland",
};

function formatValidationPath(path: readonly unknown[]): string {
  return path
    .filter((part): part is string => typeof part === "string")
    .map((part) => fieldLabels[part] ?? part)
    .join(".");
}

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const validationMessage = error.cause instanceof ZodError
      ? error.cause.issues.map((issue) => {
          const path = formatValidationPath(issue.path);
          return path ? `${path}: ${issue.message}` : issue.message;
        }).join(" ")
      : null;
    const serializedValidationMessage = validationMessage
      ? null
      : formatValidationMessage(shape.message);
    const formattedValidationMessage = validationMessage ?? serializedValidationMessage;
    const data = process.env.NODE_ENV === "production"
      ? { ...shape.data, stack: undefined }
      : shape.data;
    return {
      ...shape,
      data,
      message: error.code === "INTERNAL_SERVER_ERROR"
        ? "Interner Serverfehler"
        : formattedValidationMessage ?? shape.message,
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
