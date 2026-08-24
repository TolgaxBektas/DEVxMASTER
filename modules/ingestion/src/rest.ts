import type { Express, Request, Response } from "express";
import Busboy from "busboy";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import * as XLSX from "xlsx";
import type { Storage } from "@xmaster-center/integrations";
import {
  appendAudit,
  createDrizzleAuditRepository,
  createDrizzleEventRepository,
  isRetryableAuditWriteError,
  type AuditRepository,
  type EventExecutor,
} from "@xmaster-center/kernel";
import type { IngestionDocument, IngestionRepository } from "./repository.js";
import type { PifReviewClient } from "./review-client.js";

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

export type OccurrenceImageDependencies = {
  repository: IngestionRepository;
  storage: Storage;
};

export function registerReviewImageRoutes(
  app: Express,
  deps: { reviewClient: PifReviewClient; reviewTenantId?: string },
) {
  app.get("/api/ingestion/reviews/:id/:kind", (request, response) => {
    void (async () => {
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth) {
        response.status(401).json({ code: "UNAUTHORIZED", message: "Anmeldung erforderlich" });
        return;
      }
      if (!auth.permissions.has("ingestion.review.read")) {
        response.status(403).json({ code: "FORBIDDEN", message: "Berechtigung zum Lesen der Prüfung erforderlich" });
        return;
      }
      if (!deps.reviewTenantId) {
        response.status(404).json({ code: "NOT_FOUND", message: "Die Prüfung ist nicht konfiguriert" });
        return;
      }
      if (auth.tenantId !== deps.reviewTenantId) {
        response.status(403).json({ code: "FORBIDDEN", message: "Prüffall gehört zu einem anderen Mandanten" });
        return;
      }
      const id = Number(request.params.id);
      const kind = request.params.kind;
      if (!Number.isInteger(id) || id <= 0 || (kind !== "original" && kind !== "restored")) {
        response.status(404).json({ code: "NOT_FOUND", message: "Bild nicht gefunden" });
        return;
      }
      try {
        const bytes = await deps.reviewClient.image(id, kind);
        response.type("png").send(Buffer.from(bytes));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bild konnte nicht geladen werden";
        response.status(message === "Prüffall wurde nicht gefunden" ? 404 : 502)
          .json({ code: "PIF_UNAVAILABLE", message });
      }
    })();
  });
}


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
  registerOccurrenceImageRoute(app, {
    repository: deps.repository,
    storage: deps.storage,
  });
  registerOccurrenceExportRoute(app, {
    repository: deps.repository,
    storage: deps.storage,
  });
}

export function registerOccurrenceExportRoute(
  app: Express,
  deps: OccurrenceImageDependencies,
) {
  app.get("/api/ingestion/occurrences/export", (request, response) => {
    void handleOccurrenceExport(
      request as AuthenticatedRequest,
      response,
      deps,
    );
  });
}

export const occurrenceExportHeaders = [
  "Firma",
  "Telefon",
  "E-Mail",
  "Website",
  "Ort/PLZ",
  "Heft",
  "Ausgabe",
  "Seite",
  "Jahr",
  "Aktualität",
  "Status",
  "Zuversicht",
  "Belege",
  "Anzeigentext",
  "Bilddatei",
  "Fundstelle-ID",
  "Dokument-ID",
] as const;

export type OccurrenceExportRow = {
  values: Array<string | number>;
  imageKey: string | null;
  sourceImageKey: string | null;
};

function exportCompanyName(company: string) {
  const cleaned = company.normalize("NFKC").trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 160) || "unbekannte-firma";
}

function exportYear(document: IngestionDocument) {
  const classification = document.classification;
  if (!classification?.periodStartYear && !classification?.periodEndYear) return "unbelegt";
  if (classification.periodStartYear && classification.periodEndYear
    && classification.periodStartYear !== classification.periodEndYear) {
    return `${classification.periodStartYear}-${classification.periodEndYear}`;
  }
  return String(classification.periodStartYear ?? classification.periodEndYear);
}

export async function buildOccurrenceExportRows(
  repository: IngestionRepository,
  tenantId: string,
  filters: { documentId?: number; status?: string } = {},
): Promise<OccurrenceExportRow[]> {
  const [occurrences, documents] = await Promise.all([
    repository.listOccurrences(tenantId),
    repository.listDocuments(tenantId),
  ]);
  const documentById = new Map(documents.map((document) => [document.id, document]));
  return occurrences
    .filter((occurrence) => filters.documentId === undefined || occurrence.documentId === filters.documentId)
    .filter((occurrence) => !filters.status || occurrence.status === filters.status)
    .flatMap((occurrence) => {
      const document = documentById.get(occurrence.documentId);
      if (!document) return [];
      const classification = document.classification;
      const imageKey = occurrence.imageKey
        ? `bilder/${occurrence.id}-${exportCompanyName(occurrence.company)}.png`
        : null;
      return [{
        imageKey,
        sourceImageKey: occurrence.imageKey ?? null,
        values: [
          occurrence.company,
          occurrence.contacts?.phone ?? "",
          occurrence.contacts?.email ?? "",
          occurrence.contacts?.website ?? "",
          [occurrence.contacts?.postalCode, occurrence.contacts?.city]
            .filter((value): value is string => Boolean(value))
            .join(" "),
          classification?.publicationName ?? "",
          classification?.editionLabel ?? "",
          occurrence.pageNumber ?? "",
          exportYear(document),
          document.actualityStatus,
          occurrence.status,
          occurrence.confidence ?? "",
          (occurrence.evidence ?? []).join(", "),
          occurrence.preview,
          imageKey ?? "",
          occurrence.id,
          occurrence.documentId,
        ],
      }];
    });
}

export async function createOccurrenceExportZip(
  rows: OccurrenceExportRow[],
  storage: Storage,
) {
  const imageEntries = await attachOccurrenceExportImages(rows, storage);
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    [...occurrenceExportHeaders],
    ...rows.map((row) => row.values),
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Anzeigen");
  const workbookBytes = XLSX.write(workbook, {
    bookType: "xlsx",
    type: "buffer",
  }) as Buffer;
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", rejectArchive);
  archive.pipe(stream);
  archive.append(workbookBytes, { name: "anzeigen.xlsx" });
  archive.append("", { name: "bilder/" });
  for (const image of imageEntries) {
    archive.append(Buffer.from(image.bytes), { name: image.name });
  }
  await archive.finalize();
  return result;

  function rejectArchive(error: Error) {
    stream.destroy(error);
  }
}

export async function attachOccurrenceExportImages(
  rows: OccurrenceExportRow[],
  storage: Storage,
) {
  const imageEntries: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const row of rows) {
    if (!row.imageKey) continue;
    const occurrenceImage = row.sourceImageKey
      ? await storage.get(row.sourceImageKey)
      : null;
    if (!occurrenceImage) {
      row.values[14] = "";
      continue;
    }
    imageEntries.push({ name: row.imageKey, bytes: occurrenceImage });
  }
  return imageEntries;
}

async function handleOccurrenceExport(
  request: AuthenticatedRequest,
  response: Response,
  deps: OccurrenceImageDependencies,
) {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ code: "UNAUTHORIZED", message: "Anmeldung erforderlich" });
    return;
  }
  if (!auth.permissions.has("ingestion.occurrence.read")) {
    response.status(403).json({ code: "FORBIDDEN", message: "Berechtigung zum Lesen der Fundstellen erforderlich" });
    return;
  }
  const rawDocumentId = request.query.documentId ?? request.query.document;
  const rawStatus = request.query.status;
  const documentId = rawDocumentId === undefined
    ? undefined
    : Number(rawDocumentId);
  if (documentId !== undefined && (!Number.isInteger(documentId) || documentId <= 0)) {
    response.status(400).json({ code: "BAD_REQUEST", message: "Ungültige Dokumentkennung" });
    return;
  }
  const status = typeof rawStatus === "string" ? rawStatus : undefined;
  try {
    const rows = await buildOccurrenceExportRows(deps.repository, auth.tenantId, {
      ...(documentId === undefined ? {} : { documentId }),
      ...(status === undefined ? {} : { status }),
    });
    const archive = await createOccurrenceExportZip(rows, deps.storage);
    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Disposition", 'attachment; filename="anzeigen.zip"');
    response.send(archive);
  } catch (error) {
    console.error("[ingestion] occurrence export failed", error);
    response.status(500).json({ code: "INTERNAL_ERROR", message: "Export konnte nicht erstellt werden" });
  }
}

export function registerOccurrenceImageRoute(
  app: Express,
  deps: OccurrenceImageDependencies,
) {
  app.get("/api/ingestion/occurrences/:id/image", (request, response) => {
    void handleOccurrenceImage(
      request as AuthenticatedRequest,
      response,
      deps,
    );
  });
}

async function handleOccurrenceImage(
  request: AuthenticatedRequest,
  response: Response,
  deps: OccurrenceImageDependencies,
) {
  const auth = request.auth;
  if (!auth) {
    response.status(401).json({ code: "UNAUTHORIZED", message: "Anmeldung erforderlich" });
    return;
  }
  if (!auth.permissions.has("ingestion.occurrence.read")) {
    response.status(403).json({ code: "FORBIDDEN", message: "Berechtigung zum Lesen der Fundstelle erforderlich" });
    return;
  }
  const occurrenceId = Number(request.params.id);
  if (!Number.isInteger(occurrenceId) || occurrenceId <= 0) {
    response.status(400).json({ code: "BAD_REQUEST", message: "Ungültige Fundstellenkennung" });
    return;
  }
  try {
    const occurrence = await deps.repository.getOccurrence(auth.tenantId, occurrenceId);
    if (!occurrence.imageKey) {
      response.status(404).json({ code: "NOT_FOUND", message: "Für diese Fundstelle ist kein Ausschnitt vorhanden." });
      return;
    }
    const bytes = await deps.storage.get(occurrence.imageKey);
    if (!bytes) {
      response.status(404).json({ code: "NOT_FOUND", message: "Der Ausschnitt ist nicht mehr verfügbar." });
      return;
    }
    response.type("png").send(Buffer.from(bytes));
  } catch (error) {
    if (String(error).includes("Fundstelle nicht gefunden")) {
      response.status(404).json({ code: "NOT_FOUND", message: "Fundstelle nicht gefunden." });
      return;
    }
    console.error("[ingestion] occurrence image failed", error);
    response.status(500).json({ code: "INTERNAL_ERROR", message: "Ausschnitt konnte nicht geladen werden" });
  }
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
