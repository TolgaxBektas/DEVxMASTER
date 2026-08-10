import cookieParser from "cookie-parser";
import cors from "cors";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { ZodError, z } from "zod";
import {
  appendAudit,
  type AuditRepository,
  type ModuleRegistry,
} from "@xmaster-center/kernel";
import {
  createLocalProvider,
  resolveSession,
  type AuthRequest,
  type AuthProvider,
  type LocalAuthOptions,
  type LocalIdentity,
} from "@xmaster-center/kernel";
import type { AuthContext } from "@xmaster-center/contracts";

type Runtime = {
  registry: ModuleRegistry;
  providers: AuthProvider[];
  local?: ReturnType<typeof createLocalProvider>;
  publicOrigin: string;
  audit: AuditRepository;
  login?(input: {
    externalId: string;
    secret: string;
    tenantId?: string;
  }): Promise<LocalIdentity | null>;
};

function toAuthRequest(request: Request): AuthRequest {
  return {
    headers: request.headers as Record<string, string | string[] | undefined>,
    cookies: request.cookies,
    query: request.query as Record<string, string | undefined>,
  };
}

export function createApiApp(runtime: Runtime): Express {
  const app = express();
  const loginAttempts = new Map<
    string,
    { failures: number; lockedUntil: number }
  >();
  const secureCookie = new URL(runtime.publicOrigin).protocol === "https:";
  const recordLogin = async (
    action: "login.succeeded" | "login.failed",
    input: { externalId: string; ip: string; identity?: LocalIdentity },
  ) => {
    await appendAudit(runtime.audit, {
      tenantId: input.identity?.tenantId ?? null,
      action,
      entityType: "auth",
      entityId: input.externalId,
      actorId: input.identity?.userId ?? null,
      actorName: input.identity?.displayName ?? input.ip,
      detailsJson: JSON.stringify({ ip: input.ip }),
    });
  };
  app.use(cors({ origin: runtime.publicOrigin, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(async (request, _response, next) => {
    try {
      const auth = await resolveSession(toAuthRequest(request), {
        providers: runtime.providers,
      });
      (request as Request & { auth?: AuthContext | null }).auth = auth;
      next();
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/health", async (_request, response, next) => {
    try {
      response.json({ ok: true, modules: await runtime.registry.health() });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/auth/local", async (request, response, next) => {
    try {
      const input = z
        .object({
          externalId: z.string().min(1),
          secret: z.string().min(1),
          tenantId: z.string().optional(),
        })
        .parse(request.body);
      const ip = request.ip || request.socket.remoteAddress || "unknown";
      const attemptKey = `${ip}:${input.externalId}`;
      const attempt = loginAttempts.get(attemptKey);
      if (attempt && attempt.lockedUntil > Date.now()) {
        response.status(429).json({
          code: "RATE_LIMITED",
          message: "Zu viele Anmeldeversuche; später erneut versuchen",
        });
        return;
      }
      const identity = await runtime.login?.({
        externalId: input.externalId,
        secret: input.secret,
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      });
      if (!identity || !runtime.local) {
        const failures = (attempt?.failures ?? 0) + 1;
        loginAttempts.set(attemptKey, {
          failures,
          lockedUntil: failures >= 5 ? Date.now() + 15 * 60_000 : 0,
        });
        await recordLogin("login.failed", {
          externalId: input.externalId,
          ip,
        });
        response
          .status(401)
          .json({ code: "UNAUTHORIZED", message: "Anmeldung fehlgeschlagen" });
        return;
      }
      loginAttempts.delete(attemptKey);
      await recordLogin("login.succeeded", {
        externalId: input.externalId,
        ip,
        identity,
      });
      const token = await runtime.local.signSession(identity);
      response.cookie("xmc_session", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: secureCookie,
        maxAge: 8 * 60 * 60 * 1000,
        path: "/",
      });
      response.json({
        user: {
          id: identity.userId,
          email: identity.email,
          displayName: identity.displayName,
        },
        tenantId: identity.tenantId,
      });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/auth/session", (request, response) => {
    const auth = (request as Request & { auth?: AuthContext | null }).auth;
    if (!auth) {
      response.status(401).json({
        code: "UNAUTHORIZED",
        message: "Anmeldung erforderlich",
      });
      return;
    }
    response.json({ user: auth.user, tenantId: auth.tenantId });
  });
  app.post("/api/auth/logout", (_request, response) => {
    response.clearCookie("xmc_session", { httpOnly: true, sameSite: "lax" });
    response.status(204).end();
  });
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: runtime.registry.router,
      createContext: ({ req }) => ({
        auth: (req as Request & { auth?: AuthContext | null }).auth ?? null,
      }),
    }),
  );
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      if (error instanceof ZodError) {
        response.status(400).json({
          code: "BAD_REQUEST",
          message: "Ungültige Eingabe",
        });
        return;
      }
      response.status(500).json({
        code: "INTERNAL_ERROR",
        message: "Interner Serverfehler",
      });
    },
  );
  return app;
}

export function createLocalRuntime(options: LocalAuthOptions) {
  return createLocalProvider(options);
}
