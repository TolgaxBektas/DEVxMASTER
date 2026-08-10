import { z } from "zod";

export const idSchema = z.union([
  z.string().min(1),
  z.number().int().positive(),
]);
export type Id = z.infer<typeof idSchema>;
export const tenantIdSchema = z.string().min(1);
export type TenantId = z.infer<typeof tenantIdSchema>;
export const userIdSchema = z.string().min(1);
export type UserId = z.infer<typeof userIdSchema>;
export const currencySchema = z.enum(["EUR", "GBP"]);
export type Currency = z.infer<typeof currencySchema>;
export const languageSchema = z.enum(["de", "en", "tr"]);
export type Language = z.infer<typeof languageSchema>;
export const decimalSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,6})?$/, "decimal must be a string");
export type Decimal = z.infer<typeof decimalSchema>;

export const paginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type PaginationInput = z.infer<typeof paginationSchema>;
export type Page<T> = { items: T[]; nextCursor: string | null };

export const errorCodeSchema = z.enum([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PROVIDER_NOT_CONFIGURED",
  "BUDGET_EXCEEDED",
  "CONTENT_ANCHOR_VIOLATION",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const errorShapeSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorShape = z.infer<typeof errorShapeSchema>;

export const tenantSchema = z.object({
  id: tenantIdSchema,
  name: z.string(),
  code: z.string(),
});
export type Tenant = z.infer<typeof tenantSchema>;
export const userSchema = z.object({
  id: userIdSchema,
  email: z.string().email().nullable(),
  displayName: z.string(),
});
export type User = z.infer<typeof userSchema>;
export const permissionSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/);
export type Permission = z.infer<typeof permissionSchema>;
export const authProviderSchema = z.enum(["local", "oauth", "token"]);
export type AuthProviderName = z.infer<typeof authProviderSchema>;
export type AuthContext = {
  user: User;
  tenantId: TenantId;
  permissions: ReadonlySet<Permission>;
  provider: AuthProviderName;
  tokenId?: string;
};

export const eventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  tenantId: tenantIdSchema,
  occurredAt: z.coerce.date(),
  aggregateType: z.string().min(1),
  aggregateId: idSchema,
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const moneySchema = z.object({
  amount: decimalSchema,
  currency: currencySchema,
});
export type Money = z.infer<typeof moneySchema>;
