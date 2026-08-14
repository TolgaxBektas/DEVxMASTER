import type { Express, Request, Response } from "express";
import Busboy from "busboy";
import { createHash } from "node:crypto";
import type { Storage } from "@xmaster-center/integrations";
import {
  appendAudit,
  createDrizzleAuditRepository,
  createDrizzleEventRepository,
  isRetryableAuditWriteError,
  type AuditRepository,
  type EventExecutor,
} from "@xmaster-center/kernel";
import type { IngestionRepository } from "./repository.js";

type AuthenticatedRequest = Request & {
  auth?: { tenantId: string; userId: string; displayName: string; permissions: ReadonlySet<string> } | null;
};

export type UploadDependencies = {
  db: unknown;
  repository: IngestionRepository;
  repositoryFor?: (db: unknown) => IngestionRepository;
  storage: Storage;
  audit: AuditRepository;
  auditFor?: (db: unknown) => AuditRepository;
  transaction<T>(callback: (db: unknown) => Promise<T>): Promise<T>;
  publish(
    input: {
      name: string;
      tenantId: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
      idempotencyKey: string;
    },
    executor?: EventExecutor,
  ): Promise<unknown>;
  enqueue(input: { name: string; tenantId: string; payload: unknown }): Promise<unknown>;
  maxUploadBytes: number;
};

export async function persistDocumentBytes(
  deps: UploadDependencies,
  input: {
    tenantId: string;
    userId: string | null;
    displayName: string;
    bytes: Buffer;
    filename: string;
    origin: string;
    sourceId?: number | null;
  },
) {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const storageKey = `tenants/${input.tenantId}/originals/${sha256}/${safeFilename(input.filename)}`;
  await deps.storage.put(storageKey, input.bytes, "application/pdf");
  let result: Awaited<ReturnType<IngestionRepository["createUploadedDocument"]>> | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      result = await deps.transaction(async (db) => {
        const repository = deps.repositoryFor?.(db) ?? deps.repository;
        const created = await repository.createUploadedDocument(input.tenantId, {
          filename: input.filename,
          sourceId: input.sourceId ?? null,
          sha256,
          storageKey,
          sizeBytes: input.bytes.length,
          mimeType: "application/pdf",
          origin: input.origin,
        });
        if (created.deduplicated) return created;
        const audit = deps.auditFor?.(db) ?? deps.audit;
        await appendAudit(audit, {
          tenantId: input.tenantId,
          action: "ingestion.document.uploaded",
          entityType: "ingestion_document",
          entityId: created.document.id,
          actorId: input.userId,
          actorName: input.displayName,
          detailsJson: JSON.stringify({ sha256, filename: input.filename, origin: input.origin }),
        }, { maxAttempts: 1 });
        await deps.publish({
          name: "document.ingested",
          tenantId: input.tenantId,
          aggregateType: "document",
          aggregateId: String(created.document.id),
          payload: { documentId: created.document.id },
          idempotencyKey: `document.ingested:${input.tenantId}:${sha256}`,
        }, createDrizzleEventRepository(db));
        return created;
      });
      break;
    } catch (error) {
      if (!isRetryableAuditWriteError(error) || attempt === 4) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 150) * (attempt + 1)));
    }
  }
  if (!result) throw new Error("Dokument konnte nicht gespeichert werden");
  return { ...result, sha256, storageKey };
}

export function registerUploadRoute(app: Express, deps: UploadDependencies) {
  app.post("/api/ingestion/documents/upload", (request, response) => {
    void handleUpload(request as AuthenticatedRequest, response, deps);
  });
}

async function handleUpload(
  request: AuthenticatedRequest,
  response: Response,
  deps: UploadDependencies,
) {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ code: "UNAUTHORIZED", message: "Anmeldung erforderlich" });
    return;
  }
  if (!auth.permissions.has("ingestion.document.upload")) {
    response.status(403).json({ code: "FORBIDDEN", message: "Berechtigung zum Hochladen erforderlich" });
    return;
  }
  try {
    const upload = await readPdf(request, deps.maxUploadBytes);
    const result = await persistDocumentBytes(deps, {
      tenantId: auth.tenantId,
      userId: auth.userId,
      displayName: auth.displayName,
      bytes: upload.bytes,
      filename: upload.filename,
      origin: "upload",
    });
    if (!result.deduplicated) {
      await deps.enqueue({
        name: "ingestion.processing.run",
        tenantId: auth.tenantId,
        payload: { documentId: result.document.id },
      });
    }
    response.status(result.deduplicated ? 200 : 201).json({
      documentId: result.document.id,
      filename: result.document.filename,
      state: result.document.state,
      deduplicated: result.deduplicated,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "upload_failed";
    const userError = reason === "file_too_large"
      || reason === "Keine gültige PDF-Datei"
      || reason === "Multipart-Upload erforderlich"
      || reason === "Dateifeld fehlt";
    if (!userError) console.error("[ingestion] upload failed", error);
    const status = reason === "file_too_large" ? 413 : userError ? 400 : 500;
    const message = reason === "file_too_large"
      ? `Datei zu groß (maximal ${formatUploadLimit(deps.maxUploadBytes)})`
      : userError ? reason : "Upload konnte nicht gespeichert werden";
    response.status(status).json({ code: "UPLOAD_REJECTED", message });
  }
}

function readPdf(request: Request, maxBytes: number): Promise<{ bytes: Buffer; filename: string }> {
  return new Promise((resolve, reject) => {
    const contentType = request.headers["content-type"];
    if (!contentType?.startsWith("multipart/form-data")) {
      reject(new Error("Multipart-Upload erforderlich"));
      return;
    }
    const parser = Busboy({ headers: request.headers, limits: { fileSize: maxBytes } });
    const chunks: Buffer[] = [];
    let filename = "upload.pdf";
    let fileSeen = false;
    let tooLarge = false;
    parser.on("file", (_field, file, info) => {
      fileSeen = true;
      filename = info.filename || filename;
      file.on("data", (chunk: Buffer) => chunks.push(chunk));
      file.on("limit", () => {
        tooLarge = true;
        file.resume();
      });
    });
    parser.on("error", reject);
    parser.on("finish", () => {
      if (tooLarge) return reject(new Error("file_too_large"));
      if (!fileSeen) return reject(new Error("Dateifeld fehlt"));
      const bytes = Buffer.concat(chunks);
      if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        return reject(new Error("Keine gültige PDF-Datei"));
      }
      resolve({ bytes, filename });
    });
    request.pipe(parser);
  });
}

function safeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 255) || "upload.pdf";
}

function formatUploadLimit(bytes: number) {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)} MB`;
  }
  if (bytes >= 1024 && bytes % 1024 === 0) {
    return `${bytes / 1024} KB`;
  }
  return `${bytes} Bytes`;
}
