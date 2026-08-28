import {
  appendAudit,
  createDrizzleAuditRepository,
  createDrizzleEventRepository,
  defineModule,
  NonRetryableError,
  type EventExecutor,
  type ModuleDefinition,
} from "@xmaster-center/kernel";
import type { Storage } from "@xmaster-center/integrations";
import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { join, parse } from "node:path";
import { ingestionSchema } from "./schema.js";
import { createIngestionRouter } from "./router.js";
import { MemoryIngestionRepository } from "./memory-repository.js";
import { createDrizzleIngestionRepository } from "./drizzle-repository.js";
import { occurrenceFingerprint, type IngestionRepository } from "./repository.js";
import { registerReviewImageRoutes, registerUploadRoute } from "./rest.js";
import { persistDocumentBytes } from "./rest.js";
import { deriveDocumentClassification } from "./classification.js";
import { documentActualityStatus } from "./actuality.js";
import { publishCurrentActualityTransition } from "./actuality-replay.js";
import { ingestionPages, IngestionPage, OccurrencesPage, ReviewPage, AreasPage } from "./ui/index.js";
import type { PifReviewClient } from "./review-client.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { areaSearchTerms } from "./search-terms.js";
import { PUBLISHER_SEED_PAGES } from "./publishers.js";
import { areaWebsiteSeeds } from "./website-registry.js";

export const MIN_DOCUMENT_ADVERTISEMENTS = 3;
export const MIN_DOCUMENT_PAGES = 16;

function sameSourceHost(firstUrl: string, secondUrl: string): boolean {
  try {
    const normalize = (value: string) => new URL(value).hostname.toLocaleLowerCase("de-DE").replace(/^www\./, "");
    return normalize(firstUrl) === normalize(secondUrl);
  } catch {
    return false;
  }
}

export type AdBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
};

export type ProcessedPage = {
  pageNumber: number;
  text: string;
  imageKey: string;
  classification: string;
  adProbability: number;
  titleCandidates?: Array<{ text: string; size: number }>;
  occurrences: Array<{
    bbox: AdBoundingBox;
    imageKey: string;
    confidence: number;
    evidence: string[];
    company: string;
    preview: string;
    contacts?: OccurrenceContacts;
  }>;
};
export type OccurrenceContacts = {
  phone: string | null;
  email: string | null;
  website: string | null;
  postalCode: string | null;
  city: string | null;
};

type JobContext = { job: { tenantId: string | null } };

export function advertisementEventIdempotencyKey(
  tenantId: string,
  documentSha256: string,
  occurrence: {
    pageNumber?: number;
    company: string;
    preview: string;
    bbox?: Record<string, number> | null;
  },
): string {
  return `advertisement.detected:${tenantId}:${documentSha256}:page-${occurrence.pageNumber ?? "unknown"}:${occurrenceFingerprint(occurrence)}`;
}

function jobTenantId(context: unknown) {
  const tenantId = (context as JobContext).job?.tenantId;
  if (!tenantId) throw new Error("Mandant für Job fehlt");
  return tenantId;
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message !== error.message) {
      return `${error.message} (${cause.name}: ${cause.message})`;
    }
    return error.message || error.name;
  }
  return typeof error === "string" ? error : "Unbekannter Fehler";
}

export function isPermanentSourceFetchError(message: string): boolean {
  if (/\blast_retryable_error\b/i.test(message)) return false;
  return [
    /\bhttp[_ ]4\d\d\b/i,
    /\bdownload_truncated\b/i,
    /\barchive_captures_exhausted\b/i,
    /\bnot_a_real_pdf_signature\b/i,
    /\b(?:redirect_limit_exceeded|policy[_ ]blocked|redirect_policy_blocked)\b/i,
    /\bfile_too_large\b/i,
  ].some((pattern) => pattern.test(message));
}

function jobDocumentId(payload: unknown) {
  const documentId = (payload as { documentId?: unknown }).documentId;
  return typeof documentId === "number" ? documentId : null;
}

type WatchFolderPersistInput = {
  tenantId: string;
  userId: string | null;
  displayName: string;
  bytes: Buffer;
  filename: string;
  origin: string;
};

type WatchFolderScanDependencies = {
  folderPath: string;
  tenantId: string;
  observations: Map<string, { size: number; observations: number }>;
  persist: (input: WatchFolderPersistInput) => Promise<{
    document: { id: number };
    deduplicated: boolean;
  }>;
  enqueue: (input: {
    name: string;
    tenantId: string;
    payload: unknown;
  }) => Promise<unknown>;
};

async function validateReadablePdf(bytes: Buffer) {
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1) {
      throw new Error("PDF enthält keine Seite");
    }
    await document.getPage(1);
  } catch (error) {
    throw new Error("PDF ist nicht lesbar", { cause: error });
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

async function moveWatchFile(
  sourcePath: string,
  folderPath: string,
  bucket: "erfolgreich" | "bereits-vorhanden" | "fehlerhaft",
  filename: string,
) {
  const destinationFolder = join(folderPath, bucket);
  await mkdir(destinationFolder, { recursive: true });
  const parsed = parse(filename);
  let destination = join(destinationFolder, filename);
  try {
    await stat(destination);
    destination = join(
      destinationFolder,
      `${parsed.name}-${Date.now()}${parsed.ext}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(sourcePath, destination);
}

export async function scanWatchFolder(deps: WatchFolderScanDependencies) {
  const folderPath = deps.folderPath.trim();
  if (!folderPath) return;
  let entries;
  try {
    await mkdir(folderPath, { recursive: true });
    entries = await readdir(folderPath, { withFileTypes: true });
  } catch (error) {
    console.error("[ingestion] Überwachungsordner konnte nicht gelesen werden", error);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.pdf$/i.test(entry.name)) continue;
    const sourcePath = join(folderPath, entry.name);
    try {
      const fileStats = await stat(sourcePath);
      const previous = deps.observations.get(sourcePath);
      if (!previous || previous.size !== fileStats.size) {
        deps.observations.set(sourcePath, { size: fileStats.size, observations: 1 });
        continue;
      }
      if (previous.observations < 2) previous.observations += 1;
      if (previous.observations < 2) continue;

      const bytes = await readFile(sourcePath);
      if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        throw new Error("Keine gültige PDF-Datei");
      }
      await validateReadablePdf(bytes);
      const result = await deps.persist({
        tenantId: deps.tenantId,
        userId: null,
        displayName: "Ingestion-Worker",
        bytes,
        filename: entry.name,
        origin: "folder",
      });
      if (!result.deduplicated) {
        await deps.enqueue({
          name: "ingestion.processing.run",
          tenantId: deps.tenantId,
          payload: { documentId: result.document.id },
        });
      }
      await moveWatchFile(
        sourcePath,
        folderPath,
        result.deduplicated ? "bereits-vorhanden" : "erfolgreich",
        entry.name,
      );
      deps.observations.delete(sourcePath);
    } catch (error) {
      console.error(`[ingestion] Datei aus Überwachungsordner fehlgeschlagen: ${entry.name}`, error);
      try {
        await moveWatchFile(sourcePath, folderPath, "fehlerhaft", entry.name);
      } catch (moveError) {
        console.error(`[ingestion] Fehlerdatei konnte nicht verschoben werden: ${entry.name}`, moveError);
      }
      deps.observations.delete(sourcePath);
    }
  }
}

export function createIngestionModule(deps: {
  db?: unknown;
  repository?: IngestionRepository;
  audit?: ReturnType<typeof createDrizzleAuditRepository>;
  storage?: Storage;
  maxUploadBytes?: number;
  transaction?: <T>(callback: (db: unknown) => Promise<T>) => Promise<T>;
  repositoryForTransaction?: (db: unknown) => IngestionRepository;
  enqueue?: (input: { name: string; tenantId?: string | null; payload: unknown }) => Promise<unknown>;
  publish(input: {
    name: string;
    tenantId: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }, executor?: EventExecutor): Promise<unknown>;
  processDocument?: (input: {
    tenantId: string;
    documentId: number;
    storageKey: string;
    outputPrefix: string;
  }) => Promise<ProcessedPage[] & { pdfMetadata?: {
    title?: string;
    subject?: string;
    creationDate?: string;
  } }>;
  fetchSource?: (input: {
    url: string;
    archiveUrl?: string;
    archiveTimestamp?: string;
    archiveLength?: number;
    archiveCaptures?: Array<{
      url: string;
      timestamp?: string;
      statusCode?: number;
      length?: number | null;
    }>;
  }) => Promise<{
    bytes: Buffer;
    filename: string;
    origin?: string;
  }>;
  discoverProposals?: (input: {
    seedPages: string[];
    archiveDomains?: string[];
    searchTerms: string[];
    maxResults: number;
    areaName?: string;
  }) => Promise<Array<{
    url: string; score: number; metadata: Record<string, unknown>;
  }> | {
    proposals: Array<{ url: string; score: number; metadata: Record<string, unknown> }>;
    domainEvidence?: Array<{
      host: string;
      status?: string;
      entry_count?: number;
      attempts?: number;
      error?: string | null;
    }>;
  }>;
  revisitSource?: (input: { url: string; fingerprint?: string | null }) => Promise<{
    httpStatus?: number | null;
    newPdfUrls?: string[];
    newPdfCount?: number;
    changed?: boolean;
    fingerprint?: string | null;
    note?: string | null;
  }>;
  reviewClient?: PifReviewClient;
  reviewTenantId?: string;
  watchFolderPath?: string;
}): ModuleDefinition {
  const repository = deps.repository ?? (deps.db
    ? createDrizzleIngestionRepository(deps.db)
    : new MemoryIngestionRepository());
  const watchObservations = new Map<string, { size: number; observations: number }>();
  return defineModule({
    id: "ingestion",
    title: "Dokumente",
    icon: "file",
    version: "0.1.0",
    schema: ingestionSchema,
    router: createIngestionRouter(
      repository,
      deps.publish,
      deps.enqueue,
      deps.discoverProposals,
      deps.reviewClient,
      deps.reviewTenantId,
      deps.audit,
    ),
    ...(deps.db && deps.storage && deps.audit && deps.transaction && deps.enqueue
      ? {
          rest: (app: Parameters<typeof registerUploadRoute>[0]) => {
            registerUploadRoute(app, {
              db: deps.db!,
              repository,
              ...(deps.repositoryForTransaction
                ? { repositoryFor: (db: unknown) => createDrizzleIngestionRepository(db) }
                : {}),
              storage: deps.storage as Storage,
              audit: deps.audit as ReturnType<typeof createDrizzleAuditRepository>,
              auditFor: (db) => createDrizzleAuditRepository(db),
              transaction: deps.transaction as <T>(callback: (db: unknown) => Promise<T>) => Promise<T>,
              publish: deps.publish,
              enqueue: (input) => deps.enqueue!(input),
              maxUploadBytes: deps.maxUploadBytes ?? 25 * 1024 * 1024,
            });
            if (deps.reviewClient) {
              registerReviewImageRoutes(app, {
                reviewClient: deps.reviewClient,
                ...(deps.reviewTenantId ? { reviewTenantId: deps.reviewTenantId } : {}),
              });
            }
          },
        }
      : {}),
    nav: [
      { id: "ingestion.sources", label: "Quellen", href: "/ingestion/sources", permission: "ingestion.source.read", order: 5 },
      { id: "ingestion.areas", label: "Gebiete", href: "/ingestion/areas", permission: "ingestion.area.read", order: 6 },
      { id: "ingestion.documents", label: "Dokumente", href: "/ingestion", permission: "ingestion.document.read", order: 10 },
      { id: "ingestion.occurrences", label: "Fundstellen", href: "/ingestion/occurrences", permission: "ingestion.occurrence.read", order: 20 },
    ],
    pages: ingestionPages.map(([id, title, path, permission]) => ({
      id,
      title,
      path,
      permission,
      component: path === "/ingestion/occurrences"
        ? OccurrencesPage
        : path === "/ingestion/areas"
          ? AreasPage
        : path === "/ingestion/review"
          ? ReviewPage
          : IngestionPage,
    })),
    permissions: [
      { permission: "ingestion.source.read", title: "Quellen lesen" },
      { permission: "ingestion.source.search", title: "Quellen suchen" },
      { permission: "ingestion.source.approve", title: "Quellen freigeben" },
      { permission: "ingestion.source.fetch", title: "Quellen abrufen" },
      { permission: "ingestion.area.read", title: "Gebiete lesen" },
      { permission: "ingestion.area.run", title: "Gebietsläufe starten" },
      { permission: "ingestion.document.read", title: "Dokumente lesen" },
      { permission: "ingestion.document.write", title: "Dokumente aufnehmen" },
      { permission: "ingestion.document.upload", title: "Dokumente hochladen" },
      { permission: "ingestion.document.classify", title: "Dokumente einordnen" },
      { permission: "ingestion.occurrence.read", title: "Fundstellen lesen" },
      { permission: "ingestion.occurrence.review", title: "Fundstellen entscheiden" },
      { permission: "ingestion.review.read", title: "Prüffälle lesen" },
      { permission: "ingestion.review.decide", title: "Prüffälle entscheiden" },
    ],
    jobs: [
      {
        name: "ingestion.discovery.run",
        schedule: "daily",
        handle: async (payload, context) => {
          const tenantId = jobTenantId(context);
          const now = new Date();
          const configuredLimit = (payload as { limit?: unknown }).limit;
          const limit = typeof configuredLimit === "number" && configuredLimit > 0 ? Math.floor(configuredLimit) : 3;
          const areas = (await repository.listAreas(tenantId))
            .filter((area) =>
              area.level === "district"
              && (area.status === "pending"
              || (area.nextDueAt !== null && area.nextDueAt <= now)
              || (area.status === "running"
                && (area.startedAt === null
                  || area.startedAt.getTime() <= now.getTime() - 24 * 86_400_000))),
            )
            .sort((a, b) => a.orderIndex - b.orderIndex)
            .slice(0, limit);
          for (const area of areas) {
            await repository.updateArea(tenantId, area.id, { status: "running", startedAt: now, lastError: null });
            try {
              if (!deps.discoverProposals) throw new Error("Quellensuche ist nicht konfiguriert");
              const websiteSelection = areaWebsiteSeeds(area.ags, area.municipalityOffset ?? 0);
              const heartbeatFn = (context as { heartbeat?: () => Promise<boolean> }).heartbeat;
              const heartbeat = heartbeatFn
                ? setInterval(() => { void heartbeatFn(); }, 30_000)
                : null;
              let discovery: Awaited<ReturnType<NonNullable<typeof deps.discoverProposals>>>;
              try {
                discovery = await deps.discoverProposals({
                  seedPages: [
                    ...PUBLISHER_SEED_PAGES,
                    ...websiteSelection.seedPages,
                  ],
                  archiveDomains: websiteSelection.archiveDomains,
                  searchTerms: areaSearchTerms(area.name, area.level, undefined, area.kind),
                  maxResults: 40,
                  areaName: area.name,
                });
              } finally {
                if (heartbeat) clearInterval(heartbeat);
              }
              const proposals = Array.isArray(discovery) ? discovery : discovery.proposals;
              const domainEvidence = Array.isArray(discovery) ? undefined : discovery.domainEvidence;
              const incompleteHosts = domainEvidence?.filter((item) =>
                item.status !== "ok" && item.status !== "empty",
              ) ?? [];
              let foundSources = 0;
              const sourceErrors: string[] = [];
              for (const proposal of proposals) {
                try {
                  const source = await repository.createSource(tenantId, {
                    ...proposal,
                    areaId: area.id,
                    revisitIntervalDays: 90,
                    nextCheckAt: new Date(now.getTime() + 90 * 86_400_000),
                  });
                  if (source.areaId === area.id) foundSources += 1;
                  else if (source.areaId === null) {
                    await repository.updateSource(tenantId, source.id, { areaId: area.id });
                    foundSources += 1;
                  }
                } catch (error) {
                  sourceErrors.push(
                    `${proposal.url}: ${describeError(error)}`,
                  );
                }
              }
              const nextIncompleteRuns = incompleteHosts.length > 0
                ? (area.incompleteRuns ?? 0) + 1
                : 0;
              const retryNormally = incompleteHosts.length > 0 && nextIncompleteRuns >= 5;
              const incompleteDetails = incompleteHosts.map((item) =>
                `${item.host}: ${(item.error || item.status || "unbekannt").replace(/\s+/g, " ").slice(0, 200)}`,
              );
              const visibleIncompleteDetails = incompleteDetails.slice(0, 10).join(", ");
              const omittedIncompleteHosts = incompleteDetails.length - 10;
              const incompleteError = incompleteHosts.length > 0
                ? `discovery_incomplete: ${incompleteHosts.length} Hosts unbeantwortet (${
                    visibleIncompleteDetails
                  }${omittedIncompleteHosts > 0 ? `, … +${omittedIncompleteHosts} weitere` : ""})`
                : null;
              await repository.updateArea(tenantId, area.id, {
                status: "done",
                lastRunAt: now,
                startedAt: null,
                nextDueAt: new Date(now.getTime() + (
                  retryNormally || incompleteHosts.length === 0
                    ? 180
                    : 1
                ) * 86_400_000),
                foundSources,
                ...(retryNormally || incompleteHosts.length === 0
                  ? { municipalityOffset: websiteSelection.nextMunicipalityOffset }
                  : {}),
                incompleteRuns: nextIncompleteRuns,
                lastError: [incompleteError, ...sourceErrors].filter(Boolean).join("\n") || null,
              });
            } catch (error) {
              await repository.updateArea(tenantId, area.id, {
                status: "pending",
                startedAt: null,
                lastError: describeError(error),
              });
            }
          }
          if (deps.enqueue) await deps.enqueue({
            name: "ingestion.processing.run",
            tenantId,
            payload: {},
          });
        },
      },
      {
        name: "ingestion.source.revisit",
        schedule: "daily",
        handle: async (payload, context) => {
          const tenantId = jobTenantId(context);
          if (!deps.revisitSource) throw new Error("Quellenprüfung ist nicht konfiguriert");
          const configuredLimit = (payload as { limit?: unknown }).limit;
          const limit = typeof configuredLimit === "number" && configuredLimit > 0 ? Math.floor(configuredLimit) : 25;
          const now = new Date();
          const allSources = await repository.listSources(tenantId);
          const sources = allSources
            .filter((source) => source.status === "approved" && source.nextCheckAt !== null && source.nextCheckAt <= now)
            .sort((a, b) => (a.nextCheckAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.nextCheckAt?.getTime() ?? Number.MAX_SAFE_INTEGER))
            .slice(0, limit);
          const knownUrls = new Set(allSources.map((source) => source.url));
          for (const source of sources) {
            try {
              const result = await deps.revisitSource({ url: source.url, fingerprint: source.fingerprint });
              const httpStatus = result.httpStatus ?? null;
              const targetFailure = httpStatus !== null && httpStatus >= 400;
              if (targetFailure) {
                const failures = source.revisitFailures + 1;
                const note = result.note ?? `Zielquelle antwortete mit HTTP ${httpStatus}`;
                await repository.createSourceVisit(tenantId, {
                  sourceId: source.id, checkedAt: now, httpStatus,
                  newPdfCount: 0, changed: false, note,
                });
                await repository.updateSource(tenantId, source.id, {
                  status: failures >= 3 ? "dead" : source.status,
                  revisitFailures: failures,
                  nextCheckAt: failures >= 3
                    ? null
                    : new Date(now.getTime() + 90 * 86_400_000),
                  lastError: note,
                });
                continue;
              }
              const urls = result.newPdfUrls ?? [];
              let newCount = 0;
              for (const url of urls) {
                const isNew = !knownUrls.has(url);
                const candidate = await repository.createSource(tenantId, {
                  url,
                  score: 100,
                  metadata: { discoveredFrom: source.url, discovery: "revisit" },
                  areaId: source.areaId,
                  revisitIntervalDays: 90,
                  nextCheckAt: new Date(now.getTime() + 90 * 86_400_000),
                });
                knownUrls.add(url);
                if (isNew) newCount += 1;
                const trustedHost = sameSourceHost(source.url, url);
                const wasApproved = candidate.status === "approved";
                if (trustedHost && !wasApproved) {
                  await repository.updateSource(tenantId, candidate.id, {
                    status: "approved",
                    approvedBy: "Ingestion-Worker",
                    approvedAt: now,
                    nextCheckAt: new Date(now.getTime() + 90 * 86_400_000),
                    lastError: null,
                  });
                }
                const approvedCandidate = trustedHost && !wasApproved
                  ? await repository.getSource(tenantId, candidate.id)
                  : candidate;
                if (trustedHost && !wasApproved && approvedCandidate.status === "approved" && deps.enqueue) {
                  await deps.enqueue({ name: "ingestion.source.fetch", tenantId, payload: { sourceId: candidate.id } });
                }
              }
              if (result.changed && urls.length === 0 && deps.enqueue) {
                await deps.enqueue({
                  name: "ingestion.source.fetch",
                  tenantId,
                  payload: { sourceId: source.id },
                });
              }
              const productive = source.productive || newCount > 0 || result.changed === true;
              await repository.createSourceVisit(tenantId, {
                sourceId: source.id,
                checkedAt: now,
                httpStatus: result.httpStatus ?? null,
                newPdfCount: newCount,
                changed: result.changed ?? newCount > 0,
                note: result.note ?? null,
              });
              await repository.updateSource(tenantId, source.id, {
                productive,
                fingerprint: result.fingerprint ?? source.fingerprint,
                nextCheckAt: new Date(now.getTime() + (productive ? 30 : 90) * 86_400_000),
                lastError: null,
                revisitFailures: 0,
              });
              await deps.publish({
                name: "ingestion.source.revisited",
                tenantId,
                aggregateType: "source",
                aggregateId: String(source.id),
                payload: { sourceId: source.id, newPdfCount: newCount, changed: result.changed ?? false },
                idempotencyKey: `ingestion.source.revisited:${tenantId}:${source.id}:${now.toISOString()}`,
              });
            } catch (error) {
              const failures = source.revisitFailures + 1;
              const note = "Quellenprüfung fehlgeschlagen";
              await repository.createSourceVisit(tenantId, {
                sourceId: source.id, checkedAt: now, httpStatus: null, newPdfCount: 0,
                changed: false, note,
              });
              await repository.updateSource(tenantId, source.id, {
                status: failures >= 3 ? "dead" : source.status,
                revisitFailures: failures,
                nextCheckAt: failures >= 3 ? null : new Date(now.getTime() + 90 * 86_400_000),
                lastError: note,
              });
            }
          }
        },
      },
      {
        name: "ingestion.source.fetch",
        schedule: "daily",
        maxAttempts: 10,
        handle: async (payload, context) => {
          const tenantId = jobTenantId(context);
          const sourceId = (payload as { sourceId?: unknown }).sourceId;
          if (typeof sourceId !== "number") throw new Error("Quelle für Abruf fehlt");
          const source = await repository.getSource(tenantId, sourceId);
          if (source.status !== "approved") throw new Error("Quelle ist nicht freigegeben");
          if (!deps.fetchSource) throw new Error("Quellenabruf ist nicht konfiguriert");
          const metadata = source.metadata ?? {};
          try {
            const fetched = await deps.fetchSource({
              url: source.url,
              ...(typeof metadata.archiveUrl === "string" ? { archiveUrl: metadata.archiveUrl } : {}),
              ...(typeof metadata.archiveTimestamp === "string"
                ? { archiveTimestamp: metadata.archiveTimestamp }
                : {}),
              ...(typeof metadata.archiveLength === "number"
                ? { archiveLength: metadata.archiveLength }
                : {}),
              ...(Array.isArray(metadata.archiveCaptures)
                ? {
                    archiveCaptures: metadata.archiveCaptures.filter(
                      (item): item is {
                        url: string;
                        timestamp?: string;
                        statusCode?: number;
                        length?: number | null;
                      } => Boolean(
                        item
                        && typeof item === "object"
                        && typeof (item as { url?: unknown }).url === "string",
                      ),
                    ),
                  }
                : {}),
            });
            const result = await persistDocumentBytes({
              db: deps.db,
              repository,
              ...(deps.repositoryForTransaction
                ? { repositoryFor: deps.repositoryForTransaction }
                : {}),
              storage: deps.storage!,
              audit: deps.audit!,
              auditFor: (db) => createDrizzleAuditRepository(db),
              transaction: deps.transaction!,
              publish: deps.publish,
              enqueue: deps.enqueue!,
              maxUploadBytes: 250 * 1024 * 1024,
            }, {
              tenantId,
              userId: null,
              displayName: "Ingestion-Worker",
              bytes: fetched.bytes,
              filename: fetched.filename,
              origin: fetched.origin ?? "source",
              sourceId,
            });
            await repository.updateSource(tenantId, sourceId, {
              lastFetchedAt: new Date(),
              lastError: null,
            });
            if (!result.deduplicated) {
              await deps.enqueue!({ name: "ingestion.processing.run", tenantId, payload: { documentId: result.document.id } });
            }
          } catch (error) {
            const message = error instanceof Error && error.message
              ? error.message
              : "Quellenabruf fehlgeschlagen: unbekannter Fehler";
            const origin = typeof metadata.archiveUrl === "string"
              ? `live_then_archive:${metadata.archiveTimestamp ?? "unknown"}:${metadata.archiveUrl}`
              : "live";
            const contextualMessage =
              `source_fetch_failed: url=${source.url}; origin=${origin}; ${message}`;
            const contextualError = isPermanentSourceFetchError(message)
              ? new NonRetryableError(contextualMessage)
              : new Error(contextualMessage);
            await repository.updateSource(tenantId, sourceId, {
              lastError: contextualError.message,
            });
            throw contextualError;
          }
        },
      },
      {
        name: "ingestion.watchfolder.scan",
        schedule: "frequent",
        handle: async (_payload, context) => {
          const tenantId = jobTenantId(context);
          if (!deps.watchFolderPath?.trim()) return;
          await scanWatchFolder({
            folderPath: deps.watchFolderPath,
            tenantId,
            observations: watchObservations,
            persist: (input) => persistDocumentBytes({
              db: deps.db,
              repository,
              ...(deps.repositoryForTransaction
                ? { repositoryFor: deps.repositoryForTransaction }
                : {}),
              storage: deps.storage!,
              audit: deps.audit!,
              auditFor: (db) => createDrizzleAuditRepository(db),
              transaction: deps.transaction!,
              publish: deps.publish,
              enqueue: deps.enqueue!,
              maxUploadBytes: 250 * 1024 * 1024,
            }, input),
            enqueue: (input) => deps.enqueue!(input),
          });
        },
      },
      {
        name: "ingestion.processing.run",
        schedule: "daily",
        handle: async (payload, context) => {
          const tenantId = jobTenantId(context);
          const documentId = (payload as { documentId?: unknown }).documentId;
          const documents = typeof documentId === "number"
            ? [await repository.getDocument(tenantId, documentId)]
            : await repository.listDocuments(tenantId);
          for (const document of documents.filter((item) => item.state === "uploaded" || item.state === "failed")) {
            if (!deps.processDocument || !deps.transaction) {
              await repository.setDocumentState(tenantId, document.id, "failed", "Verarbeitung ist nicht konfiguriert");
              continue;
            }
            await repository.setDocumentState(tenantId, document.id, "processing");
            try {
              const pages = await deps.processDocument({
                tenantId,
                documentId: document.id,
                storageKey: document.storageKey,
                outputPrefix: `tenants/${tenantId}/processed/${document.sha256}`,
              });
              const advertisementCount = pages.reduce(
                (total, page) => total + page.occurrences.length,
                0,
              );
              const documentGateError = (document.origin === "source" || document.origin.startsWith("source-"))
                && (pages.length < MIN_DOCUMENT_PAGES
                || advertisementCount < MIN_DOCUMENT_ADVERTISEMENTS)
                ? `Dokumenttor abgewiesen: ${advertisementCount} Anzeigen auf ${pages.length} Seiten; erforderlich sind mindestens ${MIN_DOCUMENT_ADVERTISEMENTS} Anzeigen und ${MIN_DOCUMENT_PAGES} Seiten.`
                : null;
              await deps.transaction(async (db) => {
                const txRepository = deps.repositoryForTransaction?.(db)
                  ?? createDrizzleIngestionRepository(db);
              const previousOccurrences = (await txRepository.listOccurrences(tenantId))
                .filter((item) => item.documentId === document.id);
              const previousStatus = document.actualityStatus;
              await txRepository.upsertDerivedClassification(
                tenantId,
                document.id,
                deriveDocumentClassification({
                  filename: document.filename,
                  pages,
                  ...(pages.pdfMetadata ? { pdfMetadata: pages.pdfMetadata } : {}),
                }),
              );
              const occurrences = await txRepository.replaceProcessedDocument(
                tenantId,
                document.id,
                documentGateError
                  ? pages.map((page) => ({ ...page, occurrences: [] }))
                  : pages,
                documentGateError ? { includeOccurrences: false } : undefined,
              );
              if (documentGateError) {
                await txRepository.setDocumentState(
                  tenantId,
                  document.id,
                  "rejected",
                  documentGateError,
                );
                return;
              }
              const processedDocument = await txRepository.getDocument(tenantId, document.id);
              const executor = createDrizzleEventRepository(db);
              const actualityStatus = processedDocument.actualityStatus
                ?? documentActualityStatus(processedDocument.classification);
              if (
                previousOccurrences.length > 0
                && previousStatus !== actualityStatus
                && actualityStatus === "current"
              ) {
                await publishCurrentActualityTransition({
                  tenantId,
                  document: processedDocument,
                  previousStatus,
                  currentStatus: actualityStatus,
                  occurrences,
                  publish: deps.publish,
                  executor,
                });
              }
              for (const occurrence of occurrences) {
                await deps.publish({
                  name: "advertisement.detected",
                  tenantId,
                  aggregateType: "occurrence",
                  aggregateId: String(occurrence.id),
                  payload: {
                    occurrenceId: occurrence.id,
                    documentId: document.id,
                    company: occurrence.company,
                    preview: occurrence.preview,
                    actualityStatus,
                  },
                  idempotencyKey: advertisementEventIdempotencyKey(
                    tenantId,
                    document.sha256,
                    occurrence,
                  ),
                }, executor);
              }
              if (deps.audit) {
                await appendAudit(createDrizzleAuditRepository(db), {
                  tenantId,
                  action: "ingestion.document.processed",
                  entityType: "ingestion_document",
                  entityId: document.id,
                  actorId: null,
                  actorName: "Ingestion-Worker",
                  detailsJson: JSON.stringify({ occurrences: occurrences.length }),
                });
              }
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : "Verarbeitung fehlgeschlagen";
              await repository.setDocumentState(tenantId, document.id, "failed", message);
              if (typeof documentId === "number") {
                throw error;
              }
            }
          }
        },
        onFailure: async (error, context) => {
          const documentId = jobDocumentId((context as { job: { payload: unknown } }).job.payload);
          if (documentId === null) return;
          const message = error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Verarbeitung fehlgeschlagen";
          let tenantId: string;
          try {
            tenantId = jobTenantId(context);
          } catch {
            const document = await repository.getDocumentById(documentId);
            tenantId = document.tenantId;
          }
          const document = await repository.getDocument(tenantId, documentId);
          if (document.state !== "failed") {
            await repository.setDocumentState(tenantId, documentId, "failed", message);
          }
        },
      },
    ],
    events: [
      { name: "document.ingested", direction: "published" },
      { name: "advertisement.detected", direction: "published" },
      { name: "ingestion.source.revisited", direction: "published" },
    ],
    health: () => ({ id: "ingestion", status: "healthy" }),
  });
}
