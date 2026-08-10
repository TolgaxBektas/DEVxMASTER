import type { Express, Request, Response } from "express";
import Busboy from "busboy";
import { createHash } from "node:crypto";
import type { Storage } from "@xmaster-center/integrations";
import {
  appendAudit,
  createDrizzleAuditRepository,
  createDrizzleEventRepository,
  type AuditRepository,
  type EventExecutor,
} from "@xmaster-center/kernel";
import type { IngestionRepository } from "./repository.js";

type AuthenticatedRequest = Request & {
  auth?: { tenantId: string; userId: string; displayName: string; permissions: ReadonlySet<string> } | null;
};

type UploadDependencies = {
  db: unknown;
  repository: IngestionRepository;
  repositoryFor?(db: unknown): IngestionRepository;
  storage: Storage;
  audit: AuditRepository;
  auditFor?(db: unknown): AuditRepository;
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
    const sha256 = createHash("sha256").update(upload.bytes).digest("hex");
    const storageKey = `tenants/${auth.tenantId}/originals/${sha256}/${safeFilename(upload.filename)}`;
    await deps.storage.put(storageKey, upload.bytes, "application/pdf");
    const result = await deps.transaction(async (db) => {
      const repository = deps.repositoryFor?.(db) ?? deps.repository;
      const created = await repository.createUploadedDocument(auth.tenantId, {
        filename: upload.filename,
        sha256,
        storageKey,
        sizeBytes: upload.bytes.length,
        mimeType: "application/pdf",
        origin: "upload",
      });
      if (created.deduplicated) return created;
      const audit = deps.auditFor?.(db) ?? deps.audit;
      await appendAudit(audit, {
        tenantId: auth.tenantId,
        action: "ingestion.document.uploaded",
        entityType: "ingestion_document",
        entityId: created.document.id,
        actorId: auth.userId,
        actorName: auth.displayName,
        detailsJson: JSON.stringify({ sha256, filename: upload.filename }),
      });
      await deps.publish(
        {
          name: "document.ingested",
          tenantId: auth.tenantId,
          aggregateType: "document",
          aggregateId: String(created.document.id),
          payload: { documentId: created.document.id },
          idempotencyKey: `document.ingested:${sha256}`,
        },
        createDrizzleEventRepository(db),
      );
      return created;
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
    const status = reason === "file_too_large" ? 413 : 400;
    const message = reason === "file_too_large"
      ? `Datei zu groß (maximal ${formatUploadLimit(deps.maxUploadBytes)})`
      : reason === "upload_failed" ? "Upload fehlgeschlagen" : reason;
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
