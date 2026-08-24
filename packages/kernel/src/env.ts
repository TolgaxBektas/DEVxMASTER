import { z } from "zod";

const optionalUrl = z.string().url().optional().or(z.literal(""));

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRY: z.string().default("8h"),
  ADMIN_PIN: z.string().min(4).default("1907"),
  PUBLIC_APP_ORIGIN: z.string().url(),
  S3_ENDPOINT: optionalUrl,
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  PIF_BASE_URL: z.string().url().default("http://127.0.0.1:8010"),
  PIF_SERVICE_TOKEN: z.string().optional(),
  PIF_REVIEW_TENANT_ID: z.string().min(1).optional(),
  INGESTION_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  INGESTION_WATCH_FOLDER: z.string().optional(),
  INGESTION_WATCH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  MANUS_FORGE_BASE_URL: optionalUrl,
  MANUS_FORGE_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().email().default("noreply@example.invalid"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Ungültige Umgebungsvariablen: ${details}`);
  }
  return result.data;
}
