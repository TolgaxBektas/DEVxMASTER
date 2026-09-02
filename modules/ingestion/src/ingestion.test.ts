import { describe, expect, it } from "vitest";
import {
  MemoryAuditRepository,
  MemoryEventRepository,
  NonRetryableError,
} from "@xmaster-center/kernel";
import type { AuthContext } from "@xmaster-center/contracts";
import { MemoryIngestionRepository } from "./memory-repository.js";
import {
  advertisementEventIdempotencyKey,
  createIngestionModule,
  isPermanentSourceFetchError,
} from "./module.js";
import { deriveDocumentClassification, selectRegionSource } from "./classification.js";
import { createDrizzleIngestionRepository } from "./drizzle-repository.js";
import { classifications, documents, occurrences, pages } from "./schema.js";
import { classificationCorrectionSchema, createIngestionRouter } from "./router.js";
import { periodIncludesYear } from "./repository.js";
import { documentActualityStatus } from "./actuality.js";
import { areaWebsiteSeeds, websiteRegister } from "./website-registry.js";

const context = (tenantId: string | null, payload: unknown) => ({
  job: { tenantId, payload },
});

describe("Ingestion-Bestand", () => {
  it("arbeitet fällige Gebiete in Reihenfolge und isoliert Fehler", async () => {
    const repository = new MemoryIngestionRepository();
    await repository.upsertArea("1", {
      level: "district", ags: "01001", name: "Alpha", stateName: "Land", orderIndex: 1,
      kind: "Landkreis", status: "pending", lastRunAt: null, startedAt: null, nextDueAt: null, lastError: null, foundSources: 0,
    });
    await repository.upsertArea("1", {
      level: "district", ags: "01002", name: "Beta", stateName: "Land", orderIndex: 2,
      kind: "Landkreis", status: "pending", lastRunAt: null, startedAt: null, nextDueAt: null, lastError: null, foundSources: 0,
    });
    const calls: string[] = [];
    const module = createIngestionModule({
      repository, publish: async () => undefined, enqueue: async () => undefined,
      discoverProposals: async ({ searchTerms }) => {
        const firstTerm = searchTerms[0] ?? "";
        const name = firstTerm.split(" ").at(-1) ?? "";
        calls.push(name);
        if (name === "Beta") throw new Error("Providerfehler");
        return [{ url: "https://example.invalid/alpha.pdf", score: 80, metadata: {} }];
      },
    });
    const job = module.jobs.find((item) => item.name === "ingestion.discovery.run");
    if (!job) throw new Error("Gebietssuchjob fehlt");
    await job.handle({ limit: 2 }, context("1", {}));
    expect(calls).toEqual(["Alpha", "Beta"]);
    expect((await repository.listAreas("1")).map((area) => area.status)).toEqual(["done", "pending"]);
    expect((await repository.listSources("1"))[0]).toMatchObject({ revisitIntervalDays: 90, areaId: 1 });
  });

  it("behandelt einen vollständigen Lauf mit erfolgreicher leerer Host-Abfrage normal", async () => {
    const repository = new MemoryIngestionRepository();
    await repository.upsertArea("1", {
      level: "district", ags: "01001", name: "Alpha", stateName: "Land", orderIndex: 1,
      kind: "Landkreis", status: "pending", lastRunAt: null, startedAt: null, nextDueAt: null,
      lastError: null, foundSources: 0, municipalityOffset: 0,
    });
    const module = createIngestionModule({
      repository, publish: async () => undefined, enqueue: async () => undefined,
      discoverProposals: async () => ({
        proposals: [],
        domainEvidence: [{
          host: "alpha.example",
          status: "empty",
          entry_count: 0,
          attempts: 1,
          error: "CDX-Antwort leer",
        }],
      }),
    });
    const job = module.jobs.find((item) => item.name === "ingestion.discovery.run");
    if (!job) throw new Error("Gebietssuchjob fehlt");
    await job.handle({ limit: 1 }, context("1", {}));
    const area = (await repository.listAreas("1"))[0];
    expect(area).toMatchObject({ status: "done", incompleteRuns: 0, municipalityOffset: 1, lastError: null });
    expect(area?.nextDueAt?.getTime()).toBeGreaterThan(Date.now() + 179 * 86_400_000);
  });

  it("stellt unvollständige Läufe einen Tag zurück und bewahrt den Fortschritt", async () => {
    const repository = new MemoryIngestionRepository();
    await repository.upsertArea("1", {
      level: "district", ags: "01001", name: "Alpha", stateName: "Land", orderIndex: 1,
      kind: "Landkreis", status: "pending", lastRunAt: null, startedAt: null, nextDueAt: null,
      lastError: "alter Fehler", foundSources: 0, municipalityOffset: 7,
    });
    const module = createIngestionModule({
      repository, publish: async () => undefined, enqueue: async () => undefined,
      discoverProposals: async () => ({
        proposals: [],
        domainEvidence: [{
          host: "alpha.example", status: "error", entry_count: 0, attempts: 3,
          error: "CDX-Verbindung abgebrochen",
        }],
      }),
    });
    const job = module.jobs.find((item) => item.name === "ingestion.discovery.run");
    if (!job) throw new Error("Gebietssuchjob fehlt");
    await job.handle({ limit: 1 }, context("1", {}));
    const area = (await repository.listAreas("1"))[0];
    expect(area).toMatchObject({ status: "done", incompleteRuns: 1, municipalityOffset: 7 });
    expect(area?.lastError).toBe(
      "discovery_incomplete: 1 Hosts unbeantwortet (alpha.example: CDX-Verbindung abgebrochen)",
    );
    expect(area?.nextDueAt?.getTime()).toBeGreaterThan(Date.now() + 86_000_000);
    expect(area?.nextDueAt?.getTime()).toBeLessThan(Date.now() + 2 * 86_400_000);
  });

  it("setzt nach fünf unvollständigen Läufen die normale Fälligkeit fort", async () => {
    const repository = new MemoryIngestionRepository();
    const ags = [...new Set(websiteRegister().websites.map((website) => website.ags))].find((candidate) =>
      areaWebsiteSeeds(candidate, 0).municipalityCount > 0,
    );
    if (!ags) throw new Error("Kein Gebiet mit genügend Gemeindewebsites");
    await repository.upsertArea("1", {
      level: "district", ags, name: "Alpha", stateName: "Land", orderIndex: 1,
      kind: "Landkreis", status: "pending", lastRunAt: null, startedAt: null, nextDueAt: null,
      lastError: null, foundSources: 0, municipalityOffset: 0, incompleteRuns: 4,
    });
    const module = createIngestionModule({
      repository, publish: async () => undefined, enqueue: async () => undefined,
      discoverProposals: async () => ({
        proposals: [],
        domainEvidence: [{ host: "alpha.example", status: "error", error: "Zeitbudget überschritten" }],
      }),
    });
    const job = module.jobs.find((item) => item.name === "ingestion.discovery.run");
    if (!job) throw new Error("Gebietssuchjob fehlt");
    await job.handle({ limit: 1 }, context("1", {}));
    const area = (await repository.listAreas("1"))[0];
    expect(area?.incompleteRuns).toBe(5);
    expect(area?.municipalityOffset).toBe(areaWebsiteSeeds(ags, 0).nextMunicipalityOffset);
    expect(area?.municipalityOffset).toBeGreaterThan(0);
    expect(area?.nextDueAt?.getTime()).toBeGreaterThan(Date.now() + 179 * 86_400_000);
    expect(area?.lastError).toContain("discovery_incomplete: 1 Hosts unbeantwortet");
  });

  it("schließt ein Gebiet trotz einer fehlgeschlagenen Quellenanlage ab", async () => {
    const repository = new MemoryIngestionRepository();
    await repository.upsertArea("1", {
      level: "district", ags: "01001", name: "Alpha", stateName: "Land", orderIndex: 1,
      kind: "Landkreis", status: "pending", lastRunAt: null, startedAt: null,
      nextDueAt: null, lastError: null, foundSources: 0,
    });
    const originalCreateSource = repository.createSource.bind(repository);
    repository.createSource = async (tenantId, input) => {
      if (input.url.includes("broken")) throw new Error("HTTP 503 Quelle nicht erreichbar");
      return originalCreateSource(tenantId, input);
    };
    const module = createIngestionModule({
      repository, publish: async () => undefined, enqueue: async () => undefined,
      discoverProposals: async () => [
        { url: "https://example.invalid/broken.pdf", score: 80, metadata: {} },
        { url: "https://example.invalid/working.pdf", score: 80, metadata: {} },
      ],
    });
    const job = module.jobs.find((item) => item.name === "ingestion.discovery.run");
    if (!job) throw new Error("Gebietssuchjob fehlt");
    await job.handle({ limit: 1 }, context("1", {}));
    const area = (await repository.listAreas("1"))[0];
    expect(area?.status).toBe("done");
    expect(area?.foundSources).toBe(1);
    expect(area?.lastError).toContain("broken.pdf: HTTP 503");
    expect((await repository.listSources("1"))).toHaveLength(1);
  });

  it("speichert einen einzelnen Quellenabruf-Fehler an der Quelle", async () => {
    const repository = new MemoryIngestionRepository();
    const area = await repository.upsertArea("1", {
      level: "district", ags: "01001", name: "Alpha", stateName: "Land", orderIndex: 1,
      kind: "Landkreis", status: "done", lastRunAt: new Date(), startedAt: null,
      nextDueAt: new Date(Date.now() + 86_400_000), lastError: null, foundSources: 1,
    });
    const source = await repository.createSource("1", {
      url: "https://example.invalid/failed.pdf", score: 80, metadata: {}, areaId: area.id,
    });
    await repository.updateSource("1", source.id, { status: "approved" });
    const module = createIngestionModule({
      repository,
      fetchSource: async () => { throw new Error("HTTP 403 durch Bot-Schutz"); },
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.source.fetch");
    if (!job) throw new Error("Quellenabrufjob fehlt");
    expect(job.maxAttempts).toBe(10);
    await expect(job.handle({ sourceId: source.id }, context("1", { sourceId: source.id })))
      .rejects.toBeInstanceOf(NonRetryableError);
    expect((await repository.getSource("1", source.id)).lastError).toBe(
      "source_fetch_failed: url=https://example.invalid/failed.pdf; origin=live; HTTP 403 durch Bot-Schutz",
    );
    expect((await repository.listAreas("1"))[0]?.status).toBe("done");
  });

  it("klassifiziert dauerhafte und vorübergehende Quellenfehler getrennt", () => {
    expect(isPermanentSourceFetchError("http_404")).toBe(true);
    expect(isPermanentSourceFetchError("HTTP 400")).toBe(true);
    expect(isPermanentSourceFetchError("download_truncated: archive warning")).toBe(true);
    expect(isPermanentSourceFetchError(
      "archive_captures_exhausted: all archive captures failed permanently",
    )).toBe(true);
    expect(isPermanentSourceFetchError("policy blocked: private network")).toBe(true);
    expect(isPermanentSourceFetchError("not_a_real_pdf_signature")).toBe(true);
    expect(isPermanentSourceFetchError("file_too_large")).toBe(true);
    expect(isPermanentSourceFetchError("HTTPSConnectionPool: Read timed out")).toBe(false);
    expect(isPermanentSourceFetchError(
      "archive_fetch_failed: HTTPSConnectionPool: Read timed out",
    )).toBe(false);
    expect(isPermanentSourceFetchError(
      "archive_fetch_failed: download_truncated: archive warning; "
        + "last_retryable_error: live_fetch_failed: connection refused",
    )).toBe(false);
    expect(isPermanentSourceFetchError("http_503")).toBe(false);
  });

  it("trägt Archivherkunft und einen leeren Abruffehler am Job mit", async () => {
    const repository = new MemoryIngestionRepository();
    const source = await repository.createSource("1", {
      url: "https://example.invalid/archive.pdf",
      score: 80,
      metadata: {
        archiveUrl: "https://web.archive.org/web/20240102112233id_/https://example.invalid/archive.pdf",
        archiveTimestamp: "20240102112233",
      },
      areaId: null,
    });
    await repository.updateSource("1", source.id, { status: "approved" });
    const module = createIngestionModule({
      repository,
      fetchSource: async () => { throw ""; },
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.source.fetch");
    if (!job) throw new Error("Quellenabrufjob fehlt");

    await expect(job.handle({ sourceId: source.id }, context("1", { sourceId: source.id })))
      .rejects.toThrow(
        "source_fetch_failed: url=https://example.invalid/archive.pdf; "
        + "origin=live_then_archive:20240102112233:"
        + "https://web.archive.org/web/20240102112233id_/https://example.invalid/archive.pdf; "
        + "Quellenabruf fehlgeschlagen: unbekannter Fehler",
      );
    expect((await repository.getSource("1", source.id)).lastError).toContain(
      "origin=live_then_archive:20240102112233:",
    );
  });

  it("überspringt Bundesländer bei Gebietsläufen", async () => {
    const repository = new MemoryIngestionRepository();
    await repository.upsertArea("1", {
      level: "state", ags: "01", name: "Land", stateName: "Land", kind: "Bundesland", orderIndex: 0,
      status: "pending", lastRunAt: null, startedAt: null, nextDueAt: null, lastError: null, foundSources: 0,
    });
    await repository.upsertArea("1", {
      level: "district", ags: "01001", name: "Kreis", stateName: "Land", kind: "Landkreis", orderIndex: 1,
      status: "pending", lastRunAt: null, startedAt: null, nextDueAt: null, lastError: null, foundSources: 0,
    });
    const searched: string[] = [];
    const module = createIngestionModule({
      repository, publish: async () => undefined, enqueue: async () => undefined,
      discoverProposals: async ({ searchTerms }) => {
        searched.push(searchTerms[0] ?? "");
        return [];
      },
    });
    const job = module.jobs.find((item) => item.name === "ingestion.discovery.run");
    if (!job) throw new Error("Gebietssuchjob fehlt");
    await job.handle({ limit: 1 }, context("1", {}));
    expect(searched).toEqual(["Seniorenwegweiser Landkreis Kreis"]);
    expect((await repository.listAreas("1")).find((area) => area.level === "state")?.status).toBe("pending");
  });

  it("begrenzt Gemeinde-Seeds und setzt den Fortschrittscursor stabil fort", async () => {
    const register = websiteRegister().websites;
    const grouped = new Map<string, typeof register>();
    for (const website of register) {
      const current = grouped.get(website.ags) ?? [];
      current.push(website);
      grouped.set(website.ags, current);
    }
    const ags = [...grouped.entries()].find(([, websites]) =>
      websites.filter((website) => website.level === "gemeinde").length > 25
    )?.[0];
    if (!ags) throw new Error("Kein Gebiet mit genügend Gemeindewebsites");
    const first = areaWebsiteSeeds(ags, 0);
    const second = areaWebsiteSeeds(ags, first.nextMunicipalityOffset);
    expect(first.municipalityCount).toBe(25);
    expect(second.municipalityCount).toBe(25);
    expect(new Set(first.seedPages).size).toBe(first.seedPages.length);
    expect(first.seedPages.slice(-25)).not.toEqual(second.seedPages.slice(-25));

    const repository = new MemoryIngestionRepository();
    await repository.upsertArea("1", {
      level: "district", ags, name: "Kreis", stateName: "Land", kind: "Landkreis", orderIndex: 1,
      status: "pending", lastRunAt: null, startedAt: null, nextDueAt: null, lastError: null, foundSources: 0,
    });
    const calls: string[][] = [];
    const module = createIngestionModule({
      repository, publish: async () => undefined, enqueue: async () => undefined,
      discoverProposals: async ({ seedPages }) => { calls.push(seedPages); return []; },
    });
    const job = module.jobs.find((item) => item.name === "ingestion.discovery.run");
    if (!job) throw new Error("Gebietssuchjob fehlt");
    await job.handle({ limit: 1 }, context("1", {}));
    expect(calls[0]?.slice(-25)).toEqual(first.seedPages.slice(-25));
    expect((await repository.listAreas("1"))[0]?.municipalityOffset).toBe(25);
    await repository.updateArea("1", 1, { status: "pending", nextDueAt: new Date(0) });
    await job.handle({ limit: 1 }, context("1", {}));
    expect(calls[1]?.slice(-25)).toEqual(second.seedPages.slice(-25));
    expect((await repository.listAreas("1"))[0]?.municipalityOffset).toBe(50);
  });

  it("erlaubt für die Intensivsuche ein größeres Gemeinde-Seed-Limit", () => {
    const register = websiteRegister().websites;
    const grouped = new Map<string, typeof register>();
    for (const website of register) {
      const current = grouped.get(website.ags) ?? [];
      current.push(website);
      grouped.set(website.ags, current);
    }
    const ags = [...grouped.entries()].find(([, websites]) =>
      websites.filter((website) => website.level === "gemeinde").length > 25
    )?.[0];
    if (!ags) throw new Error("Kein Gebiet mit genügend Gemeindewebsites");

    expect(areaWebsiteSeeds(ags, 0, 500).municipalityCount).toBeGreaterThan(25);
    expect(areaWebsiteSeeds(ags, 0).seedPages).toEqual(areaWebsiteSeeds(ags, 0, 25).seedPages);
    expect(areaWebsiteSeeds(ags, 0, 0).seedPages).toEqual(areaWebsiteSeeds(ags, 0).seedPages);
  });

  it("führt mit areaAgs genau die angeforderten Gebiete unabhängig von ihrer Fälligkeit aus", async () => {
    const repository = new MemoryIngestionRepository();
    await repository.upsertArea("1", {
      level: "district", ags: "09675", name: "Kitzingen", stateName: "Bayern",
      kind: "Landkreis", orderIndex: 1, status: "done", lastRunAt: new Date(),
      startedAt: null, nextDueAt: new Date(Date.now() + 86_400_000), lastError: null, foundSources: 0,
    });
    await repository.upsertArea("1", {
      level: "district", ags: "01001", name: "Nicht angefordert", stateName: "Bayern",
      kind: "Landkreis", orderIndex: 2, status: "pending", lastRunAt: null,
      startedAt: null, nextDueAt: null, lastError: null, foundSources: 0,
    });
    const searched: string[] = [];
    let receivedTerms: string[] = [];
    let receivedMaxResults = 0;
    const module = createIngestionModule({
      repository,
      publish: async () => undefined,
      enqueue: async () => undefined,
      discoverProposals: async ({ areaName, searchTerms, maxResults }) => {
        searched.push(areaName ?? "");
        receivedTerms = searchTerms;
        receivedMaxResults = maxResults;
        return [];
      },
    });
    const job = module.jobs.find((item) => item.name === "ingestion.discovery.run");
    if (!job) throw new Error("Gebietssuchjob fehlt");

    await job.handle({
      areaAgs: ["09675"],
      limit: 1,
      municipalitySeedLimit: 500,
      intensive: true,
      maxResults: 17,
    }, context("1", {}));

    expect(searched).toEqual(["Kitzingen"]);
    expect(receivedTerms).toContain("Bürgerinformationsbroschüre Landkreis Kitzingen");
    expect(receivedMaxResults).toBe(17);
    expect((await repository.listAreas("1")).find((area) => area.ags === "09675")?.status)
      .toBe("done");
    expect((await repository.listAreas("1")).find((area) => area.ags === "01001")?.status)
      .toBe("pending");
  });

  it("markiert eine Quelle nach drei Fehlern als nicht erreichbar und setzt den Zähler bei Erfolg zurück", async () => {
    const repository = new MemoryIngestionRepository();
    const source = await repository.createSource("1", {
      url: "https://example.invalid/source.pdf", score: 50, metadata: {},
    });
    await repository.updateSource("1", source.id, {
      status: "approved", nextCheckAt: new Date(0),
    });
    let attempts = 0;
    const module = createIngestionModule({
      repository, publish: async () => undefined, enqueue: async () => undefined,
      revisitSource: async () => {
        attempts += 1;
        if (attempts < 3) return { httpStatus: 404, note: "Zielquelle antwortete mit HTTP 404" };
        return { httpStatus: 200, changed: false, fingerprint: "ok" };
      },
    });
    const job = module.jobs.find((item) => item.name === "ingestion.source.revisit");
    if (!job) throw new Error("Wiedervorlagejob fehlt");
    for (let i = 0; i < 2; i += 1) {
      await repository.updateSource("1", source.id, { nextCheckAt: new Date(0) });
      await job.handle({}, context("1", {}));
    }
    expect((await repository.getSource("1", source.id)).revisitFailures).toBe(2);
    await repository.updateSource("1", source.id, { nextCheckAt: new Date(0) });
    await job.handle({}, context("1", {}));
    expect((await repository.getSource("1", source.id)).revisitFailures).toBe(0);
    expect((await repository.getSource("1", source.id)).status).toBe("approved");
    expect(repository.sourceVisits.map((visit) => visit.httpStatus)).toEqual([404, 404, 200]);
  });

  it("greift verwaiste Gebietsläufe nach 24 Stunden wieder auf und bewahrt fremde Gebietszuordnung", async () => {
    const repository = new MemoryIngestionRepository();
    const stale = await repository.upsertArea("1", {
      level: "district", ags: "01001", name: "Stale", stateName: "Land", kind: "Landkreis", orderIndex: 1,
      status: "running", lastRunAt: null, startedAt: new Date(Date.now() - 25 * 86_400_000),
      nextDueAt: null, lastError: null, foundSources: 0,
    });
    const otherArea = await repository.upsertArea("1", {
      level: "district", ags: "01002", name: "Other", stateName: "Land", kind: "Landkreis", orderIndex: 2,
      status: "pending", lastRunAt: null, startedAt: null, nextDueAt: null, lastError: null, foundSources: 0,
    });
    const existing = await repository.createSource("1", {
      url: "https://example.invalid/existing.pdf", score: 50, metadata: {}, areaId: otherArea.id,
    });
    const module = createIngestionModule({
      repository, publish: async () => undefined, enqueue: async () => undefined,
      discoverProposals: async () => [{ url: existing.url, score: 80, metadata: {} }],
    });
    const job = module.jobs.find((item) => item.name === "ingestion.discovery.run");
    if (!job) throw new Error("Gebietssuchjob fehlt");
    await job.handle({ limit: 1 }, context("1", {}));
    expect((await repository.listAreas("1")).find((area) => area.id === stale.id)?.status).toBe("done");
    expect((await repository.getSource("1", existing.id)).areaId).toBe(otherArea.id);
  });

  it("protokolliert Quellenprüfungen und plant produktive Quellen früher erneut", async () => {
    const repository = new MemoryIngestionRepository();
    const source = await repository.createSource("1", {
      url: "https://www.example.invalid:8443/index.html", score: 50, metadata: {},
    });
    await repository.updateSource("1", source.id, {
      status: "approved", nextCheckAt: new Date(0),
    });
    const knownPdf = await repository.createSource("1", {
      url: "https://example.invalid:9443/known.pdf", score: 50, metadata: {},
    });
    await repository.updateSource("1", knownPdf.id, { status: "approved" });
    const enqueued: unknown[] = [];
    const module = createIngestionModule({
      repository, publish: async () => undefined,
      enqueue: async (item) => { enqueued.push(item); },
      revisitSource: async () => ({
        httpStatus: 200, newPdfUrls: [
          "https://example.invalid:9443/known.pdf",
          "http://example.invalid:9443/new.pdf",
        ],
        newPdfCount: 99, changed: true, fingerprint: "new",
      }),
    });
    const job = module.jobs.find((item) => item.name === "ingestion.source.revisit");
    if (!job) throw new Error("Wiedervorlagejob fehlt");
    await job.handle({}, context("1", {}));
    expect(repository.sourceVisits).toHaveLength(1);
    expect(repository.sourceVisits[0]).toMatchObject({ newPdfCount: 1, changed: true });
    expect((await repository.getSource("1", source.id)).productive).toBe(true);
    expect((await repository.getSource("1", source.id)).nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(enqueued).toHaveLength(1);
    expect((await repository.getSource("1", 2)).status).toBe("approved");
  });

  it("legt neue PDFs fremder Hosts nur als Vorschlag an", async () => {
    const repository = new MemoryIngestionRepository();
    const source = await repository.createSource("1", {
      url: "https://www.example.invalid/index.html", score: 50, metadata: {},
    });
    await repository.updateSource("1", source.id, { status: "approved", nextCheckAt: new Date(0) });
    const enqueued: unknown[] = [];
    const module = createIngestionModule({
      repository, publish: async () => undefined,
      enqueue: async (item) => { enqueued.push(item); },
      revisitSource: async () => ({
        httpStatus: 200, newPdfUrls: ["https://other.invalid/new.pdf"],
        newPdfCount: 99, changed: true, fingerprint: "new",
      }),
    });
    const job = module.jobs.find((item) => item.name === "ingestion.source.revisit");
    if (!job) throw new Error("Wiedervorlagejob fehlt");
    await job.handle({}, context("1", {}));
    const candidate = (await repository.listSources("1")).find((item) => item.url.includes("other.invalid"));
    expect(candidate?.status).toBe("proposed");
    expect(enqueued).toHaveLength(0);
    expect(repository.sourceVisits[0]).toMatchObject({ newPdfCount: 1 });
  });
  it("bewertet Aktualität relativ und lässt das Jahr unbelegt offen", () => {
    expect(documentActualityStatus({ periodStartYear: 2022, periodEndYear: 2022 }, 2025, 3)).toBe("current");
    expect(documentActualityStatus({ periodStartYear: 2021, periodEndYear: 2021 }, 2025, 3)).toBe("outdated");
    expect(documentActualityStatus({ periodStartYear: null, periodEndYear: null }, 2025, 3)).toBe("unverified");
  });

  it("hält Aktualitätsentscheidung und Jahreskorrektur in der Speicherfassung synchron", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "aktuell.pdf", sha256: "b".repeat(64), storageKey: "aktuell", sizeBytes: 10,
      mimeType: "application/pdf", origin: "upload",
    });
    await repository.upsertDerivedClassification("1", document.document.id, {
      type: null, typeSource: "first-pages", typeConfidence: null,
      publicationName: "Test", publicationNameSource: "first-pages", publicationNameConfidence: 0.5,
      editionLabel: null, editionSource: "first-pages", editionConfidence: null,
      periodStartYear: 2020, periodEndYear: 2020, periodIssue: null,
      periodSource: "first-pages", periodConfidence: 0.5,
      regionPlace: null, regionDistrict: null, regionState: null,
      regionSource: "first-pages", regionConfidence: null,
    });
    expect((await repository.getDocument("1", document.document.id)).actualityStatus).toBe("outdated");
    await repository.updateClassificationManual("1", document.document.id, {
      periodStartYear: 2025, periodEndYear: 2025,
    }, "user-1");
    expect((await repository.getDocument("1", document.document.id)).actualityStatus).toBe("current");
    await repository.decideDocumentActuality("1", document.document.id, "outdated", "user-1");
    expect((await repository.getDocument("1", document.document.id)).actualitySource).toBe("manual");
    expect((await repository.getDocument("1", document.document.id)).actualityStatus).toBe("outdated");
  });

  it("holt Leads nach einer Jahreskorrektur idempotent nach", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "unbelegt.pdf", sha256: "g".repeat(64), storageKey: "unbelegt",
      sizeBytes: 10, mimeType: "application/pdf", origin: "upload",
    });
    await repository.upsertDerivedClassification("1", document.document.id, {
      type: null, typeSource: "first-pages", typeConfidence: null,
      publicationName: null, publicationNameSource: "first-pages", publicationNameConfidence: null,
      editionLabel: null, editionSource: "first-pages", editionConfidence: null,
      periodStartYear: null, periodEndYear: null, periodIssue: null,
      periodSource: "first-pages", periodConfidence: null,
      regionPlace: null, regionDistrict: null, regionState: null,
      regionSource: "first-pages", regionConfidence: null,
    });
    repository.occurrences.push({
      id: 1, documentId: document.document.id, pageNumber: 1,
      bbox: null, imageKey: null, confidence: 0.9,
      evidence: [], company: "Muster GmbH", preview: "Telefon 0123 456789",
      status: "detected",
    });
    const audit = new MemoryAuditRepository();
    const published: Array<Record<string, unknown>> = [];
    const auth: AuthContext = {
      tenantId: "1",
      user: { id: "user-1", email: null, displayName: "Test" },
      permissions: new Set(["ingestion.document.classify"]),
      provider: "local",
    };
    const caller = createIngestionRouter(
      repository,
      async (event) => { published.push(event); },
      undefined,
      undefined,
      audit,
    ).createCaller({ auth });
    expect(await repository.listOccurrences("1")).toHaveLength(1);
    await caller.documents.correct({
      id: document.document.id,
      periodEndYear: new Date().getFullYear(),
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.payload).toMatchObject({ actualityStatus: "current" });
    expect(audit.entries).toHaveLength(1);
    await caller.documents.correct({
      id: document.document.id,
      periodEndYear: new Date().getFullYear(),
    });
    expect(published).toHaveLength(1);
    expect(audit.entries).toHaveLength(2);
    await caller.documents.actuality({ id: document.document.id, status: "outdated" });
    expect(published).toHaveLength(1);
    await caller.documents.actuality({ id: document.document.id, status: "current" });
    expect(published).toHaveLength(2);
    await caller.documents.actuality({ id: document.document.id, status: "current" });
    expect(published).toHaveLength(2);
  });
  it("leitet Arten, Zeitraum und strukturierte Regionen aus echten Titeltexten ab", () => {
    const result = deriveDocumentClassification({
      filename: "Seniorenwegweiser.pdf",
      pages: [{
        pageNumber: 1,
        text: "LEBEN UND ÄLTER WERDEN IM RHEIN-NECKAR-KREIS\nBaden-Württemberg\nAUSGABE 2020",
      }],
    });
    expect(result.type).toBe("bürger-und-seniorenwegweiser");
    expect(result.regionDistrict).toBe("Rhein-Neckar-Kreis");
    expect(result.regionState).toBe("Baden-Württemberg");
    expect(result.regionSource).toBe("title-page");
    expect(result.periodStartYear).toBe(2020);
    expect(result.periodEndYear).toBe(2020);
    expect(result.typeConfidence).toBeGreaterThan(0.9);
    expect(result.editionLabel).toBe("Ausgabe 2020");
  });

  it("liefert die Regionsherkunft aus der verwendeten Evidenz oder leer", () => {
    expect(deriveDocumentClassification({
      filename: "Bayern-Magazin.pdf",
      pages: [{ pageNumber: 1, text: "Das Magazin" }],
    })).toMatchObject({ regionState: "Bayern", regionSource: "filename" });
    expect(deriveDocumentClassification({
      filename: "magazin.pdf",
      pdfMetadata: { title: "Amtsblatt Bayern" },
      pages: [{ pageNumber: 1, text: "Das Magazin" }],
    })).toMatchObject({ regionState: "Bayern", regionSource: "pdf-metadata" });
    expect(deriveDocumentClassification({
      filename: "magazin.pdf",
      pages: [{ pageNumber: 1, text: "Das Magazin" }],
    })).toMatchObject({ regionState: null, regionSource: null });
  });

  it("verwirft eine Regionsherkunft ohne echte Übereinstimmung", () => {
    expect(selectRegionSource(
      { place: "Frankfurt", district: null, state: null, confidence: 0.5 },
      [{ source: "filename", value: { place: null, district: null, state: "Bayern", confidence: 0.5 } }],
    )).toBeNull();
  });

  it("meldet eine fehlende Quelle verständlich als nicht gefunden", async () => {
    const repository = new MemoryIngestionRepository();
    const audit = new MemoryAuditRepository();
    const auth: AuthContext = {
      tenantId: "1",
      user: { id: "user-1", email: null, displayName: "Test" },
      permissions: new Set(["ingestion.source.fetch"]),
      provider: "local",
    };
    const caller = createIngestionRouter(repository, async () => undefined, async () => undefined)
      .createCaller({ auth });
    await expect(caller.sources.fetch({ id: 999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Quelle nicht gefunden.",
    });
    expect(audit.entries).toHaveLength(0);
  });

  it("erkennt die vereinbarten Publikationsarten ohne KI", () => {
    const examples = [
      ["Amtsblatt der Gemeinde Oststeinbek.pdf", "AMTSBLATT DER GEMEINDE OSTSTEINBEK", "kommunales-amtsblatt"],
      ["Stadtmagazin Aachen.pdf", "STADTMAGAZIN AACHEN", "stadt-und-gemeindemagazin"],
      ["Seniorenwegweiser.pdf", "SENIORENWEGWEISER", "bürger-und-seniorenwegweiser"],
      ["Branchenführer 2024.pdf", "BRANCHENFÜHRER", "branchenführer"],
      ["Messekatalog 2024.pdf", "MESSEKATALOG", "messekatalog"],
    ] as const;
    for (const [filename, text, type] of examples) {
      expect(deriveDocumentClassification({
        filename,
        pages: [{ pageNumber: 1, text }],
      }).type).toBe(type);
    }
  });

  it("erkennt unbekannte Kreise und Gemeinden über Namensmuster statt Listen", () => {
    const result = deriveDocumentClassification({
      filename: "Amtsblatt Landkreis Schaumburg.pdf",
      pages: [{
        pageNumber: 1,
        text: "AMTSBLATT LANDKREIS SCHAUMBURG\nNiedersachsen\nAusgabe 3/2024",
      }],
    });
    expect(result.regionDistrict).toBe("Landkreis Schaumburg");
    expect(result.regionState).toBe("Niedersachsen");
    expect(result.periodIssue).toBe(3);
    expect(result.periodStartYear).toBe(2024);
    expect(result.periodConfidence).toBeGreaterThan(0.8);

    const municipality = deriveDocumentClassification({
      filename: "Gemeinde Wusterhausen.pdf",
      pages: [{ pageNumber: 1, text: "Gemeinde Wusterhausen\nBrandenburg" }],
    });
    expect(municipality.regionPlace).toBe("Wusterhausen");
    expect(municipality.regionState).toBe("Brandenburg");

    const state = deriveDocumentClassification({
      filename: "Amtsblatt Sachsen-Anhalt.pdf",
      pages: [{ pageNumber: 1, text: "AMTSBLATT SACHSEN-ANHALT" }],
    });
    expect(state.regionState).toBe("Sachsen-Anhalt");

    const longDistrict = deriveDocumentClassification({
      filename: "Amtsblatt Landkreis Musterstadt.pdf",
      pages: [{
        pageNumber: 1,
        text: "Der Landkreis Musterstadt informiert seine Bürgerinnen und Bürger über neue Regelungen.",
      }],
    });
    expect(longDistrict.regionDistrict).toBe("Landkreis Musterstadt");
    const overlongDistrict = deriveDocumentClassification({
      filename: "Amtsblatt Landkreis.pdf",
      pages: [{ pageNumber: 1, text: `Landkreis ${"A".repeat(101)}` }],
    });
    expect(overlongDistrict.regionDistrict).toBeNull();

    for (const expected of [
      "Mecklenburg-Vorpommern",
      "Nordrhein-Westfalen",
      "Rheinland-Pfalz",
      "Schleswig-Holstein",
    ]) {
      expect(deriveDocumentClassification({
        filename: "Amtsblatt.pdf",
        pages: [{ pageNumber: 1, text: `Amtsblatt\n${expected}` }],
      }).regionState).toBe(expected);
    }
  });

  it("hält schwache und kontextlose Signale unsicher oder leer", () => {
    const result = deriveDocumentClassification({
      filename: "Informationen.pdf",
      pages: [{ pageNumber: 1, text: "Messezeiten und Gottesdienste\nStand: 2019" }],
    });
    expect(result.type).toBeNull();
    expect(result.typeSource).toBeNull();
    expect(result.periodStartYear).toBeNull();
    expect(result.periodSource).toBeNull();
    expect(result.periodConfidence).toBeNull();
  });

  it("bevorzugt PDF-Metadaten und typografische Titel vor beliebigen Deckblattzeilen", () => {
    const filenameFallback = deriveDocumentClassification({
      filename: "unbekanntes-dokument.pdf",
      pages: [{ pageNumber: 1, text: "" }],
    });
    expect(filenameFallback.publicationName).toBe("unbekanntes-dokument");
    expect(filenameFallback.publicationNameSource).toBe("filename");
    expect(filenameFallback.publicationNameConfidence).toBe(0.35);

    const metadata = deriveDocumentClassification({
      filename: "amtsblatt.pdf",
      pages: [{ pageNumber: 1, text: "Ausgabe 2026\nSlogan", titleCandidates: [
        { text: "Amtsblatt für den Landkreis Beispiel", size: 24 },
      ] }],
      pdfMetadata: { title: "Amtsblatt Ausgabe Nr. 1 vom 7. Januar 2026" },
    });
    expect(metadata.publicationName).toBe("Amtsblatt für den Landkreis Beispiel");
    expect(metadata.publicationNameSource).toBe("title-page");

    const typography = deriveDocumentClassification({
      filename: "messe.pdf",
      pages: [{ pageNumber: 1, text: "09.-10. September 2024", titleCandidates: [
        { text: "18. Kulturbörse für Straßenkunst", size: 26 },
        { text: "09.-10. September 2024", size: 15 },
      ] }],
    });
    expect(typography.publicationName).toBe("18. Kulturbörse für Straßenkunst");
  });

  it("ordnet Herkunft trotz vorhandener Metadaten dem tatsächlichen Seitentreffer zu", () => {
    const result = deriveDocumentClassification({
      filename: "unbekannt.pdf",
      pdfMetadata: { title: "Dokument", subject: "Allgemeine Veröffentlichung" },
      pages: [{ pageNumber: 1, text: "Messekatalog Ausgabe 3/2024" }],
    });
    expect(result.type).toBe("messekatalog");
    expect(result.typeSource).toBe("title-page");
    expect(result.editionLabel).toBe("Ausgabe 3/2024");
    expect(result.editionSource).toBe("title-page");
    expect(result.periodStartYear).toBe(2024);
    expect(result.periodSource).toBe("title-page");
  });

  it("ignoriert eine irrelevante Metadaten-Jahreszahl zugunsten des verwendeten Seitentreffers", () => {
    const result = deriveDocumentClassification({
      filename: "unbekannt.pdf",
      pdfMetadata: { title: "Dokument erstellt 2019" },
      pages: [{ pageNumber: 1, text: "Ausgabe 3/2024" }],
    });
    expect(result.editionLabel).toBe("Ausgabe 3/2024");
    expect(result.editionSource).toBe("title-page");
    expect(result.periodStartYear).toBe(2024);
    expect(result.periodSource).toBe("title-page");
  });

  it("verwirft Fließtext als Ortsnamen", () => {
    const result = deriveDocumentClassification({
      filename: "magazin.pdf",
      pages: [{ pageNumber: 1, text: "Stadt Zu Verlieben\nDas Magazin" }],
    });
    expect(result.regionPlace).toBeNull();
    expect(deriveDocumentClassification({
      filename: "magazin.pdf",
      pages: [{ pageNumber: 1, text: "Stadt Wa\nDas Magazin" }],
    }).regionPlace).toBeNull();
    expect(deriveDocumentClassification({
      filename: "amtsblatt.pdf",
      pages: [{ pageNumber: 1, text: "Landkreis A informiert" }],
    }).regionDistrict).toBeNull();
    expect(deriveDocumentClassification({
      filename: "stadtmagazin.pdf",
      pages: [{ pageNumber: 1, text: "Stadt Frankfurt am Main" }],
    }).regionPlace).toBe("Frankfurt am Main");
    expect(deriveDocumentClassification({
      filename: "amtsblatt.pdf",
      pages: [{ pageNumber: 1, text: "Landkreis Rothenburg ob der Tauber" }],
    }).regionDistrict).toBe("Landkreis Rothenburg ob der Tauber");
  });

  it("gewichtet Ortsbezüge nach Häufigkeit gegenüber einem einzelnen beiläufigen Treffer", () => {
    const result = deriveDocumentClassification({
      filename: "Amtsblatt Landkreis Beispiel.pdf",
      pages: [{
        pageNumber: 1,
        text: [
          "Amtsblatt für den Landkreis Beispiel",
          "Landkreis Beispiel",
          "Landkreis Beispiel",
          "Landkreis Beispiel",
          "Gemeinde Gilching genehmigt ein Bauvorhaben.",
        ].join("\n"),
      }],
    });
    expect(result.regionDistrict).toBe("Landkreis Beispiel");
    expect(result.regionPlace).toBeNull();
  });

  it("stuft die Regionszuversicht nach der Stärke des Ortsbezugs ab", () => {
    const weak = deriveDocumentClassification({
      filename: "Gemeindemagazin Bayern.pdf",
      pages: [{ pageNumber: 1, text: "Gemeinde Gilching. Bayern" }],
    });
    const repeated = deriveDocumentClassification({
      filename: "Gemeindemagazin Bayern.pdf",
      pages: [{
        pageNumber: 1,
        text: "Gemeinde Gilching. Gemeinde Gilching. Bayern",
      }],
    });
    expect(weak.regionPlace).toBe("Gilching");
    expect(weak.regionConfidence).toBe(0.65);
    expect(repeated.regionPlace).toBe("Gilching");
    expect(repeated.regionConfidence).toBe(0.82);
  });

  it("bewahrt manuelle Korrekturen bei einer erneuten Ableitung", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "wegweiser.pdf",
      sha256: "f".repeat(64),
      storageKey: "tenants/1/originals/f/wegweiser.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    await repository.upsertDerivedClassification("1", document.document.id, deriveDocumentClassification({
      filename: "wegweiser.pdf",
      pages: [{ pageNumber: 1, text: "SENIORENWEGWEISER HAMBURG 2020" }],
    }));
    await repository.updateClassificationManual("1", document.document.id, {
      type: "stadt-und-gemeindemagazin",
      regionState: "Schleswig-Holstein",
    }, "user-1");
    await repository.upsertDerivedClassification("1", document.document.id, deriveDocumentClassification({
      filename: "wegweiser.pdf",
      pages: [{ pageNumber: 1, text: "SENIORENWEGWEISER HAMBURG\nAusgabe 2021" }],
    }));
    const result = (await repository.getDocument("1", document.document.id)).classification;
    expect(result?.type).toBe("stadt-und-gemeindemagazin");
    expect(result?.typeSource).toBe("manual");
    expect(result?.regionState).toBe("Schleswig-Holstein");
    expect(result?.regionSource).toBe("manual");
    expect(result?.periodStartYear).toBe(2021);
  });

  it("wendet manuelle Korrekturen feldweise an und bewahrt absichtliches Leeren", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "wegweiser.pdf",
      sha256: "e".repeat(64),
      storageKey: "tenants/1/originals/e/wegweiser.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    await repository.upsertDerivedClassification("1", document.document.id, deriveDocumentClassification({
      filename: "wegweiser.pdf",
      pages: [{ pageNumber: 1, text: "SENIORENWEGWEISER HAMBURG\nAusgabe 2020" }],
    }));
    await repository.updateClassificationManual("1", document.document.id, {
      regionState: null,
    }, "user-1");
    await repository.upsertDerivedClassification("1", document.document.id, deriveDocumentClassification({
      filename: "wegweiser.pdf",
      pages: [{ pageNumber: 1, text: "BRANCHENFÜHRER BERLIN\nAusgabe 2021" }],
    }));
    await repository.updateClassificationManual("1", document.document.id, {
      publicationName: "Manueller Titel",
    }, "user-1");
    const result = (await repository.getDocument("1", document.document.id)).classification;
    expect(result?.regionState).toBeNull();
    expect(result?.regionSource).toBe("manual");
    expect(result?.publicationName).toBe("Manueller Titel");
    expect(result?.publicationNameSource).toBe("manual");
    expect(result?.type).toBe("branchenführer");
    expect(result?.typeSource).toBe("title-page");
    expect(result?.periodStartYear).toBe(2021);
  });

  it("validiert Korrekturjahre verständlich", () => {
    expect(() => classificationCorrectionSchema.parse({ id: 1, periodStartYear: 999 }))
      .toThrow("Das Jahr muss mindestens 1000 sein.");
    expect(() => classificationCorrectionSchema.parse({ id: 1, periodEndYear: 2201 }))
      .toThrow("Das Jahr darf höchstens 2200 sein.");
    expect(() => classificationCorrectionSchema.parse({ id: 1, periodStartYear: 2025, periodEndYear: 2024 }))
      .toThrow("Das Endjahr darf nicht vor dem Startjahr liegen.");
    expect(classificationCorrectionSchema.parse({ id: 1, periodStartYear: 2020, periodEndYear: 2021 }))
      .toMatchObject({ periodStartYear: 2020, periodEndYear: 2021 });
    expect(() => classificationCorrectionSchema.parse({ id: 1, periodStartYear: "20xx" }))
      .toThrow();
    expect(() => classificationCorrectionSchema.parse({ id: 1, publicationName: "x".repeat(256) }))
      .toThrow("Der Publikationsname darf höchstens 255 Zeichen lang sein.");
  });

  it("verwendet für Speicher- und SQL-Zeiträume dieselbe inklusive Semantik", () => {
    expect(periodIncludesYear(2020, 2026, 2020)).toBe(true);
    expect(periodIncludesYear(2020, 2026, 2026)).toBe(true);
    expect(periodIncludesYear(2020, 2026, 2027)).toBe(false);
  });

  it("filtert Speicher-Dokumente nur innerhalb des vollständigen Zeitraums", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "zeitraum.pdf",
      sha256: "d".repeat(64),
      storageKey: "tenants/1/originals/d/zeitraum.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    await repository.upsertDerivedClassification("1", document.document.id, {
      type: null, typeSource: "first-pages", typeConfidence: null,
      publicationName: null, publicationNameSource: "first-pages", publicationNameConfidence: null,
      editionLabel: null, editionSource: "first-pages", editionConfidence: null,
      periodStartYear: 2020, periodEndYear: 2021, periodIssue: null,
      periodSource: "first-pages", periodConfidence: 0.5,
      regionPlace: null, regionDistrict: null, regionState: null,
      regionSource: "first-pages", regionConfidence: null,
    });
    expect((await repository.listDocuments("1", { periodYear: 2021 })).map((row) => row.id))
      .toContain(document.document.id);
    expect(await repository.listDocuments("1", { periodYear: 2022 })).toHaveLength(0);
  });

  it("weist eine Korrektur ohne angefasste Felder zurück", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "leer.pdf",
      sha256: "c".repeat(64),
      storageKey: "tenants/1/originals/c/leer.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    await repository.upsertDerivedClassification("1", document.document.id, {
      type: null, typeSource: "first-pages", typeConfidence: null,
      publicationName: "Titel", publicationNameSource: "first-pages", publicationNameConfidence: 0.5,
      editionLabel: null, editionSource: "first-pages", editionConfidence: null,
      periodStartYear: null, periodEndYear: null, periodIssue: null,
      periodSource: "first-pages", periodConfidence: null,
      regionPlace: null, regionDistrict: null, regionState: null,
      regionSource: "first-pages", regionConfidence: null,
    });
    await expect(repository.updateClassificationManual("1", document.document.id, {}, "user-1"))
      .rejects.toThrow("Keine Änderung vorgenommen.");
    expect((await repository.getDocument("1", document.document.id)).classification?.correctedAt).toBeNull();
  });

  it("protokolliert keine Audit-Zeile für eine Scheinkorrektur", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "audit.pdf",
      sha256: "a".repeat(64),
      storageKey: "tenants/1/originals/a/audit.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    await repository.upsertDerivedClassification("1", document.document.id, {
      type: null, typeSource: "first-pages", typeConfidence: null,
      publicationName: "Titel", publicationNameSource: "first-pages", publicationNameConfidence: 0.5,
      editionLabel: null, editionSource: "first-pages", editionConfidence: null,
      periodStartYear: null, periodEndYear: null, periodIssue: null,
      periodSource: "first-pages", periodConfidence: null,
      regionPlace: null, regionDistrict: null, regionState: null,
      regionSource: "first-pages", regionConfidence: null,
    });
    const audit = new MemoryAuditRepository();
    const auth: AuthContext = {
      tenantId: "1",
      user: { id: "user-1", email: null, displayName: "Test" },
      permissions: new Set(["ingestion.document.classify"]),
      provider: "local",
    };
    const caller = createIngestionRouter(repository, async () => undefined, undefined, undefined, audit)
      .createCaller({ auth });
    await expect(caller.documents.correct({ id: document.document.id }))
      .rejects.toThrow("Keine Änderung vorgenommen.");
    expect(audit.entries).toHaveLength(0);
  });

  it.each([
    ["nur Bis", { periodEndYear: 2019 }, false],
    ["nur Von", { periodStartYear: 2027 }, false],
    ["beide widersprüchlich", { periodStartYear: 2027, periodEndYear: 2019 }, false],
    ["beide gültig", { periodStartYear: 2024, periodEndYear: 2026 }, true],
  ])("prüft den wirksamen Zeitraum bei %s", async (_case, correction, valid) => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "zeitraum-korrektur.pdf",
      sha256: "9".repeat(64),
      storageKey: "tenants/1/originals/9/zeitraum-korrektur.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    await repository.upsertDerivedClassification("1", document.document.id, {
      type: null, typeSource: "first-pages", typeConfidence: null,
      publicationName: null, publicationNameSource: "first-pages", publicationNameConfidence: null,
      editionLabel: null, editionSource: "first-pages", editionConfidence: null,
      periodStartYear: 2024, periodEndYear: 2026, periodIssue: null,
      periodSource: "first-pages", periodConfidence: 0.5,
      regionPlace: null, regionDistrict: null, regionState: null,
      regionSource: null, regionConfidence: null,
    });
    const audit = new MemoryAuditRepository();
    const auth: AuthContext = {
      tenantId: "1",
      user: { id: "user-1", email: null, displayName: "Test" },
      permissions: new Set(["ingestion.document.classify"]),
      provider: "local",
    };
    const caller = createIngestionRouter(repository, async () => undefined, undefined, undefined, audit)
      .createCaller({ auth });
    const request = caller.documents.correct({
      id: document.document.id,
      ...correction,
    });
    if (valid) {
      await expect(request).resolves.toMatchObject({
        periodStartYear: 2024,
        periodEndYear: 2026,
      });
      expect(audit.entries).toHaveLength(1);
    } else {
      await expect(request).rejects.toThrow("Das Endjahr darf nicht vor dem Startjahr liegen.");
      expect(audit.entries).toHaveLength(0);
    }
    expect((await repository.getDocument("1", document.document.id)).classification)
      .toMatchObject({ periodStartYear: 2024, periodEndYear: 2026 });
  });

  it("liefert die Klassifikation auch aus der Drizzle-Fassung des Dokumentvertrags", async () => {
    const documentRow = {
      id: 1104,
      tenantId: 1,
      sourceId: null,
      filename: "1104.pdf",
      sha256: "a".repeat(64),
      storageKey: "tenants/1/originals/a/1104.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
      state: "processed",
      error: null,
    };
    const classificationRow = {
      type: null,
      typeSource: null,
      typeConfidence: null,
      publicationName: "Test",
      publicationNameSource: "manual",
      publicationNameConfidence: null,
      editionLabel: null,
      editionSource: null,
      editionConfidence: null,
      periodStartYear: 2024,
      periodEndYear: 2026,
      periodIssue: null,
      periodSource: "manual",
      periodConfidence: null,
      regionPlace: null,
      regionDistrict: null,
      regionState: null,
      regionSource: null,
      regionConfidence: null,
      derivedAt: null,
      correctedAt: null,
      correctedBy: null,
    };
    const database = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => table === documents ? [documentRow] : table === classifications ? [classificationRow] : [],
          }),
        }),
      }),
    };
    const repository = createDrizzleIngestionRepository(database);
    await expect(repository.getDocument("1", 1104)).resolves.toMatchObject({
      classification: { periodStartYear: 2024, periodEndYear: 2026 },
      actualityStatus: "current",
    });
  });

  it("setzt die Drizzle-Fassung bei einer Jahreskorrektur auf den abgeleiteten Zustand zurück", async () => {
    const documentRow = {
      id: 1105, tenantId: 1, sourceId: null, filename: "1105.pdf",
      sha256: "z".repeat(64), storageKey: "1105.pdf", sizeBytes: 10,
      mimeType: "application/pdf", origin: "upload", state: "processed", error: null,
    };
    const classificationRow = {
      type: null, typeSource: "first-pages", typeConfidence: null,
      publicationName: null, publicationNameSource: "first-pages", publicationNameConfidence: null,
      editionLabel: null, editionSource: "first-pages", editionConfidence: null,
      periodStartYear: null, periodEndYear: null, periodIssue: null,
      periodSource: "first-pages", periodConfidence: null,
      regionPlace: null, regionDistrict: null, regionState: null,
      regionSource: "first-pages", regionConfidence: null,
      derivedAt: null, correctedAt: null, correctedBy: null,
      actualityStatus: "outdated", actualityDecidedAt: new Date(), actualityDecidedBy: "user-1",
    };
    const query = (value: unknown) => Object.assign(
      Promise.resolve(value),
      { limit: async () => value },
    );
    const database = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => query(table === documents ? [documentRow] : [classificationRow]),
        }),
      }),
      update: () => ({
        set: (value: Record<string, unknown>) => ({
          where: async () => Object.assign(classificationRow, value),
        }),
      }),
    };
    const repository = createDrizzleIngestionRepository(database);
    await repository.updateClassificationManual("1", 1105, {
      periodEndYear: new Date().getFullYear(),
    }, "user-1");
    await expect(repository.getDocument("1", 1105)).resolves.toMatchObject({
      actualityStatus: "current",
      actualitySource: "derived",
    });
  });

  it("liefert den übernommenen Reviewstatus auch aus der Drizzle-Fassung zurück", async () => {
    const documentRow = {
      id: 1201,
      tenantId: 1,
      sourceId: null,
      filename: "1201.pdf",
      sha256: "d".repeat(64),
      storageKey: "tenants/1/originals/d/1201.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
      state: "processing",
      error: null,
    };
    const previousOccurrence = {
      id: 88,
      tenantId: 1,
      documentId: 1201,
      pageId: 77,
      company: "Muster",
      preview: "Muster Telefon",
      status: "approved",
      bbox: { confidence: 0.9, height: 1, width: 1, y: 0, x: 0 },
      imageKey: "old.png",
      confidence: 0.9,
      evidence: ["geometry"],
      createdAt: new Date(),
    };
    const previousPage = {
      id: 77,
      documentId: 1201,
      pageNumber: 1,
      text: "Anzeige",
      imageKey: "page.png",
      classification: "MIXED_CONTENT",
      adProbability: 0.9,
      createdAt: new Date(),
    };
    const query = (value: unknown) => Object.assign(
      Promise.resolve(value),
      { limit: async () => value },
    );
    const database = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => query(
            table === documents ? [documentRow]
              : table === occurrences ? [previousOccurrence]
                : table === pages ? [previousPage] : [],
          ),
        }),
      }),
      delete: () => ({ where: async () => undefined }),
      insert: (table: unknown) => ({
        values: async () => [{ insertId: table === pages ? 78 : 89 }],
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    const repository = createDrizzleIngestionRepository(database);
    const [created] = await repository.replaceProcessedDocument("1", 1201, [{
      pageNumber: 1,
      text: "Anzeige",
      imageKey: "new-page.png",
      classification: "MIXED_CONTENT",
      adProbability: 0.9,
      occurrences: [{
        bbox: { x: 0, y: 0, width: 1, height: 1, confidence: 0.9 },
        imageKey: "new.png",
        confidence: 0.9,
        evidence: ["geometry"],
        company: "Muster",
        preview: "Muster Telefon",
      }],
    }]);
    expect(created?.status).toBe("approved");
  });

  it("behandelt ein Dokument eines fremden Mandanten als nicht vorhanden", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "tenant.pdf",
      sha256: "b".repeat(64),
      storageKey: "tenants/1/originals/b/tenant.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    await repository.upsertDerivedClassification("1", document.document.id, {
      type: null, typeSource: "first-pages", typeConfidence: null,
      publicationName: "Titel", publicationNameSource: "first-pages", publicationNameConfidence: 0.5,
      editionLabel: null, editionSource: "first-pages", editionConfidence: null,
      periodStartYear: null, periodEndYear: null, periodIssue: null,
      periodSource: "first-pages", periodConfidence: null,
      regionPlace: null, regionDistrict: null, regionState: null,
      regionSource: "first-pages", regionConfidence: null,
    });
    const audit = new MemoryAuditRepository();
    const caller = createIngestionRouter(repository, async () => undefined, undefined, undefined, audit)
      .createCaller({
        auth: {
          tenantId: "2",
          user: { id: "user-2", email: null, displayName: "Mandant 2" },
          permissions: new Set(["ingestion.document.classify"]),
          provider: "local",
        },
      });
    await expect(caller.documents.correct({
      id: document.document.id,
      publicationName: "Fremder Zugriff",
    })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Dokument nicht gefunden.",
    });
    expect(audit.entries).toHaveLength(0);
  });

  it("dedupliziert Dokumente über den Inhalts-Hash", async () => {
    const repository = new MemoryIngestionRepository();
    const input = {
      filename: "a.pdf",
      sha256: "a".repeat(64),
      storageKey: "tenants/1/originals/a/a.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    };
    const first = await repository.createUploadedDocument("1", input);
    const second = await repository.createUploadedDocument("1", input);
    expect(second.document.id).toBe(first.document.id);
    expect(second.deduplicated).toBe(true);
    expect(repository.documents).toHaveLength(1);
    expect((await repository.createUploadedDocument("2", input)).deduplicated).toBe(false);
  });

  it("führt einen Dokumentzustand kontrolliert weiter", async () => {
    const repository = new MemoryIngestionRepository();
    const result = await repository.createUploadedDocument("1", {
      filename: "a.pdf",
      sha256: "b".repeat(64),
      storageKey: "tenants/1/originals/b/a.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const processing = await repository.setDocumentState("1", result.document.id, "processing");
    const updated = await repository.setDocumentState("1", result.document.id, "failed", "OCR fehlgeschlagen");
    expect(processing.state).toBe("processing");
    expect(updated.state).toBe("failed");
    expect(updated.error).toBe("OCR fehlgeschlagen");
  });

  it("publiziert eine Fundstelle trotz doppelter Zustellung nur einmal", async () => {
    const events = new MemoryEventRepository();
    const input = {
      name: "advertisement.detected",
      tenantId: "1",
      aggregateType: "occurrence",
      aggregateId: "1",
      payload: { occurrenceId: 1, documentId: 1 },
      idempotencyKey: "advertisement.detected:hash",
    } as const;
    await events.append({ ...input, id: "event-1", occurredAt: new Date() });
    await events.append({ ...input, id: "event-2", occurredAt: new Date() });
    expect(events.events).toHaveLength(1);
  });

  it("verarbeitet einen wiederholten Job ohne doppelte Fundstellen", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "a.pdf",
      sha256: "c".repeat(64),
      storageKey: "tenants/1/originals/c/a.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    let calls = 0;
    const publishedKeys: string[] = [];
    const module = createIngestionModule({
      repository,
      repositoryForTransaction: () => repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => {
        calls += 1;
        return [{
          pageNumber: 1,
          text: "Muster GmbH Werbung Telefon",
          imageKey: "page.png",
          classification: "MIXED_CONTENT",
          adProbability: 0.5,
          occurrences: [{
            bbox: { x: 0, y: 0, width: 1, height: 1, confidence: 0.8 },
            imageKey: "ad.png",
            confidence: 0.8,
            evidence: ["geometry"],
            company: "Muster GmbH",
            preview: "Muster GmbH Werbung Telefon",
          }],
        }];
      },
        publish: async (event) => {
          publishedKeys.push(event.idempotencyKey);
        },
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await job.handle(
      { documentId: document.document.id },
      context("1", { documentId: document.document.id }),
    );
    document.document.state = "uploaded";
    await job.handle(
      { documentId: document.document.id },
      context("1", { documentId: document.document.id }),
    );
    expect(calls).toBe(2);
    expect(repository.occurrences).toHaveLength(1);
    expect(publishedKeys).toHaveLength(2);
    expect(publishedKeys.some((key) => key.includes("actuality-transition"))).toBe(false);
    expect(publishedKeys[0]).toBe(publishedKeys[1]);
  });

  it("spielt beim erneuten Lauf den Übergang nach current je Fundstelle wieder ein", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "replay.pdf",
      sha256: "p".repeat(64),
      storageKey: "tenants/1/originals/p/replay.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const page = {
      pageNumber: 1,
      text: `Ausgabe ${new Date().getFullYear()}\nMuster GmbH Werbung Telefon`,
      imageKey: "page.png",
      classification: "MIXED_CONTENT",
      adProbability: 0.5,
      occurrences: [{
        bbox: { x: 0, y: 0, width: 1, height: 1, confidence: 0.8 },
        imageKey: "ad.png",
        confidence: 0.8,
        evidence: ["geometry"],
        company: "Muster GmbH",
        preview: "Muster GmbH Werbung Telefon",
      }],
    };
    await repository.replaceProcessedDocument("1", document.document.id, [page]);
    document.document.state = "uploaded";
    const publishedKeys: string[] = [];
    const module = createIngestionModule({
      repository,
      repositoryForTransaction: () => repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => [page],
      publish: async (event) => {
        publishedKeys.push(event.idempotencyKey);
      },
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await job.handle(
      { documentId: document.document.id },
      context("1", { documentId: document.document.id }),
    );
    expect(publishedKeys).toHaveLength(2);
    expect(
      publishedKeys.filter((key) => key.includes("actuality-transition")),
    ).toHaveLength(1);
  });

  it("speichert Evidenz, erhält Entscheidungen bei der erneuten Verarbeitung und auditert keine Wiederholung", async () => {
    const repository = new MemoryIngestionRepository();
    const audit = new MemoryAuditRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "review.pdf",
      sha256: "r".repeat(64),
      storageKey: "tenants/1/originals/r/review.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    await repository.replaceProcessedDocument("1", document.document.id, [{
      pageNumber: 1,
      text: "Anzeige",
      imageKey: "page.png",
      classification: "MIXED_CONTENT",
      adProbability: 0.9,
      occurrences: [{
        bbox: { x: 0, y: 0, width: 1, height: 1, confidence: 0.9 },
        imageKey: "ad.png",
        confidence: 0.9,
        evidence: ["geometry", "logo", "contact"],
        company: "Muster",
        preview: "Muster Telefon",
      }],
    }]);
    const auth: AuthContext = {
      tenantId: "1",
      user: { id: "reviewer", email: null, displayName: "Prüfer" },
      permissions: new Set(["ingestion.occurrence.read", "ingestion.occurrence.review"]),
      provider: "local",
    };
    const caller = createIngestionRouter(repository, async () => undefined, undefined, undefined, audit)
      .createCaller({ auth });
    const before = (await caller.occurrences.list())[0];
    if (!before) throw new Error("Fundstelle fehlt");
    expect(before.evidence).toEqual(["geometry", "logo", "contact"]);
    await caller.occurrences.review({ id: before.id, decision: "approved" });
    await caller.occurrences.review({ id: before.id, decision: "approved" });
    expect(audit.entries).toHaveLength(1);
    const stored = repository.occurrences[0];
    if (!stored) throw new Error("Fundstelle fehlt");
    stored.bbox = {
      confidence: 0.9000004,
      height: 1.0000004,
      width: 1.0000004,
      y: 0.0000004,
      x: 0.0000004,
    };
    await repository.replaceProcessedDocument("1", document.document.id, [{
      pageNumber: 1,
      text: "Anzeige",
      imageKey: "page.png",
      classification: "MIXED_CONTENT",
      adProbability: 0.9,
      occurrences: [{
        bbox: { x: 0.0000003, y: 0, width: 1, height: 1, confidence: 0.9 },
        imageKey: "new-ad.png",
        confidence: 0.8,
        evidence: ["geometry"],
        company: "Muster",
        preview: "Muster Telefon",
      }],
    }]);
    const after = (await repository.listOccurrences("1"))[0];
    if (!after) throw new Error("Fundstelle fehlt");
    expect(after.status).toBe("approved");
    expect(after.evidence).toEqual(["geometry"]);
  });

  it("trennt Fundstellenentscheidungen nach Mandant und Berechtigung", async () => {
    const repository = new MemoryIngestionRepository();
    const audit = new MemoryAuditRepository();
    const document = await repository.createUploadedDocument("2", {
      filename: "tenant-2.pdf",
      sha256: "t".repeat(64),
      storageKey: "tenants/2/originals/t/tenant-2.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    await repository.replaceProcessedDocument("2", document.document.id, [{
      pageNumber: 1,
      text: "Anzeige",
      imageKey: "page.png",
      classification: "MIXED_CONTENT",
      adProbability: 0.9,
      occurrences: [{
        bbox: { x: 0, y: 0, width: 1, height: 1, confidence: 0.9 },
        imageKey: "ad.png",
        confidence: 0.9,
        evidence: [],
        company: "Mandant 2",
        preview: "Telefon",
      }],
    }]);
    const auth: AuthContext = {
      tenantId: "1",
      user: { id: "viewer", email: null, displayName: "Viewer" },
      permissions: new Set(["ingestion.occurrence.read"]),
      provider: "local",
    };
    const caller = createIngestionRouter(repository, async () => undefined, undefined, undefined, audit)
      .createCaller({ auth });
    expect(await caller.occurrences.list()).toHaveLength(0);
    await expect(caller.occurrences.review({ id: 1, decision: "approved" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("bildet Fundstellen ohne Laufzeit-ID stabil und unterscheidet gleiche Firmen auf einer Seite", () => {
    const first = advertisementEventIdempotencyKey("1", "hash", {
      pageNumber: 4,
      company: "  Muster   GmbH ",
      preview: "Muster GmbH   Telefon",
      bbox: { x: 1.1111, y: 2, width: 3, height: 4, confidence: 0.8 },
    });
    const retry = advertisementEventIdempotencyKey("1", "hash", {
      pageNumber: 4,
      company: "muster gmbh",
      preview: "Muster GmbH Telefon",
      bbox: { height: 4, width: 3, y: 2, x: 1.1112, confidence: 0.8 },
    });
    const secondPlacement = advertisementEventIdempotencyKey("1", "hash", {
      pageNumber: 4,
      company: "Muster GmbH",
      preview: "Muster GmbH Telefon",
      bbox: { x: 20, y: 2, width: 3, height: 4, confidence: 0.8 },
    });
    const bboxWithMetadata = {
      x: 1.1111,
      y: 2,
      width: 3,
      height: 4,
      confidence: 0.8,
      evidence: ["geometry"],
      preview: "Muster GmbH Telefon",
    } as unknown as { x: number; y: number; width: number; height: number };
    const metadataBbox = advertisementEventIdempotencyKey("1", "hash", {
      pageNumber: 4,
      company: "Muster GmbH",
      preview: "Muster GmbH Telefon",
      bbox: bboxWithMetadata,
    });
    expect(first).toBe(retry);
    expect(secondPlacement).not.toBe(first);
    expect(metadataBbox).toBe(first);
  });

  it("setzt ein Dokument bei nicht erreichbarer Verarbeitung auf Fehler", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "a.pdf",
      sha256: "d".repeat(64),
      storageKey: "tenants/1/originals/d/a.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const module = createIngestionModule({
      repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => {
        throw new Error("PDF-Verarbeitung ist nicht erreichbar");
      },
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await expect(job.handle(
      { documentId: document.document.id },
      context("1", { documentId: document.document.id }),
    ))
      .rejects.toThrow("PDF-Verarbeitung ist nicht erreichbar");
  });

  it("setzt fehlerhafte Dokumente im Sammellauf auf Fehler und verarbeitet weitere Dokumente", async () => {
    const repository = new MemoryIngestionRepository();
    const first = await repository.createUploadedDocument("1", {
      filename: "bad.pdf",
      sha256: "b".repeat(64),
      storageKey: "bad",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const second = await repository.createUploadedDocument("1", {
      filename: "good.pdf",
      sha256: "g".repeat(64),
      storageKey: "good",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const calls: number[] = [];
    const module = createIngestionModule({
      repository,
      repositoryForTransaction: () => repository,
      transaction: async (callback) => callback({}),
      processDocument: async ({ documentId }) => {
        calls.push(documentId);
        if (documentId === first.document.id) {
          throw new Error("Kaputter PDF-Text");
        }
        return [{
          pageNumber: 1,
          text: "Verarbeitbar",
          imageKey: "page.png",
          classification: "EDITORIAL_ONLY",
          adProbability: 0.1,
          occurrences: [],
        }];
      },
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");

    await job.handle({}, context("1", {}));

    expect(calls).toEqual([first.document.id, second.document.id]);
    expect((await repository.getDocument("1", first.document.id)).state).toBe("failed");
    expect((await repository.getDocument("1", first.document.id)).error).toBe("Kaputter PDF-Text");
    expect((await repository.getDocument("1", second.document.id)).state).toBe("processed");
  });

  it("weist Dokumente ohne ausreichende Anzeigen sichtbar zurück", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "themenflyer.pdf",
      sha256: "q".repeat(64),
      storageKey: "themenflyer",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "source",
    });
    const published: unknown[] = [];
    const pages = Array.from({ length: 15 }, (_, index) => ({
      pageNumber: index + 1,
      text: "Bürgerinformation",
      imageKey: `page-${index + 1}.png`,
      classification: "EDITORIAL",
      adProbability: 0.1,
      occurrences: index < 2 ? [{
        bbox: { x: 0, y: 0, width: 1, height: 1, confidence: 0.9 },
        imageKey: `ad-${index + 1}.png`,
        confidence: 0.9,
        evidence: ["test"],
        company: `Muster ${index + 1}`,
        preview: "Telefon",
      }] : [],
    }));
    const module = createIngestionModule({
      repository,
      repositoryForTransaction: () => repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => pages,
      publish: async (event) => { published.push(event); },
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await job.handle({ documentId: document.document.id }, context("1", { documentId: document.document.id }));
    const rejected = await repository.getDocument("1", document.document.id);
    expect(rejected.state).toBe("rejected");
    expect(rejected.error).toContain("2 Anzeigen");
    expect(rejected.error).toContain("mindestens 3 Anzeigen");
    expect(await repository.listOccurrences("1")).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it("lässt ein Wegweiser-Dokument mit drei Anzeigen und 16 Seiten passieren", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "wegweiser.pdf",
      sha256: "r".repeat(64),
      storageKey: "wegweiser",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "source-archive-20260827000000",
    });
    const pages = Array.from({ length: 16 }, (_, index) => ({
      pageNumber: index + 1,
      text: "Seniorenwegweiser",
      imageKey: `page-${index + 1}.png`,
      classification: "MIXED_CONTENT",
      adProbability: index < 3 ? 0.9 : 0.1,
      occurrences: index < 3 ? [{
        bbox: { x: 0, y: 0, width: 1, height: 1, confidence: 0.9 },
        imageKey: `ad-${index + 1}.png`,
        confidence: 0.9,
        evidence: ["test"],
        company: `Muster ${index + 1}`,
        preview: "Telefon",
      }] : [],
    }));
    const module = createIngestionModule({
      repository,
      repositoryForTransaction: () => repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => pages,
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await job.handle({ documentId: document.document.id }, context("1", { documentId: document.document.id }));
    expect((await repository.getDocument("1", document.document.id)).state).toBe("processed");
    expect(await repository.listOccurrences("1")).toHaveLength(3);
  });

  it("lässt ein zwölfseitiges Mitteilungsblatt mit vier Anzeigen passieren", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "mitteilungsblatt.pdf",
      sha256: "s".repeat(64),
      storageKey: "mitteilungsblatt",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "source",
    });
    const pages = Array.from({ length: 12 }, (_, index) => ({
      pageNumber: index + 1,
      text: "Mitteilungsblatt",
      imageKey: `page-${index + 1}.png`,
      classification: "MIXED_CONTENT",
      adProbability: index < 4 ? 0.9 : 0.1,
      occurrences: index < 4 ? [{
        bbox: { x: 0, y: 0, width: 1, height: 1, confidence: 0.9 },
        imageKey: `ad-${index + 1}.png`,
        confidence: 0.9,
        evidence: ["test"],
        company: `Muster ${index + 1}`,
        preview: "Telefon",
      }] : [],
    }));
    const module = createIngestionModule({
      repository,
      repositoryForTransaction: () => repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => pages,
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await job.handle({ documentId: document.document.id }, context("1", { documentId: document.document.id }));
    expect((await repository.getDocument("1", document.document.id)).state).toBe("processed");
    expect(await repository.listOccurrences("1")).toHaveLength(4);
  });

  it("weist ein zwölfseitiges Blatt mit zwei Anzeigen weiterhin zurück", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("1", {
      filename: "kurzes-blatt.pdf",
      sha256: "t".repeat(64),
      storageKey: "kurzes-blatt",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "source",
    });
    const pages = Array.from({ length: 12 }, (_, index) => ({
      pageNumber: index + 1,
      text: "Mitteilungsblatt",
      imageKey: `page-${index + 1}.png`,
      classification: "MIXED_CONTENT",
      adProbability: index < 2 ? 0.9 : 0.1,
      occurrences: index < 2 ? [{
        bbox: { x: 0, y: 0, width: 1, height: 1, confidence: 0.9 },
        imageKey: `ad-${index + 1}.png`,
        confidence: 0.9,
        evidence: ["test"],
        company: `Muster ${index + 1}`,
        preview: "Telefon",
      }] : [],
    }));
    const module = createIngestionModule({
      repository,
      repositoryForTransaction: () => repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => pages,
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await job.handle({ documentId: document.document.id }, context("1", { documentId: document.document.id }));
    expect((await repository.getDocument("1", document.document.id)).state).toBe("rejected");
  });

  it("verarbeitet ein Dokument des zweiten Mandanten mit dem Job-Mandanten", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("2", {
      filename: "tenant-2.pdf",
      sha256: "e".repeat(64),
      storageKey: "tenants/2/originals/e/tenant-2.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const module = createIngestionModule({
      repository,
      repositoryForTransaction: () => repository,
      transaction: async (callback) => callback({}),
      processDocument: async ({ tenantId }) => [{
        pageNumber: 1,
        text: `Mandant ${tenantId}`,
        imageKey: "page.png",
        classification: "MIXED_CONTENT",
        adProbability: 0.5,
        occurrences: [],
      }],
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await job.handle(
      { documentId: document.document.id },
      context("2", { documentId: document.document.id }),
    );
    expect((await repository.getDocument("2", document.document.id)).state).toBe("processed");
  });

  it("verweigert einen Job ohne ermittelbaren Mandanten", async () => {
    const repository = new MemoryIngestionRepository();
    const module = createIngestionModule({ repository, publish: async () => undefined });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job) throw new Error("Verarbeitungsjob fehlt");
    await expect(job.handle(
      { documentId: 1 },
      context(null, { documentId: 1 }),
    )).rejects.toThrow("Mandant für Job fehlt");
  });

  it("markiert ein Dokument nach einem endgültigen Jobfehler als fehlgeschlagen", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("2", {
      filename: "tenant-2-failed.pdf",
      sha256: "f".repeat(64),
      storageKey: "tenants/2/originals/f/tenant-2-failed.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const module = createIngestionModule({
      repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => { throw new Error("PIF dauerhaft nicht erreichbar"); },
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job || !job.onFailure) throw new Error("Verarbeitungsjob fehlt");
    const failureContext = context("2", { documentId: document.document.id });
    await expect(job.handle({ documentId: document.document.id }, failureContext))
      .rejects.toThrow("PIF dauerhaft nicht erreichbar");
    await job.onFailure("PIF dauerhaft nicht erreichbar", failureContext);
    const failed = await repository.getDocument("2", document.document.id);
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("PIF dauerhaft nicht erreichbar");
  });

  it("markiert ein Dokument auch bei fehlendem Job-Mandanten als fehlgeschlagen", async () => {
    const repository = new MemoryIngestionRepository();
    const document = await repository.createUploadedDocument("2", {
      filename: "unknown-tenant.pdf",
      sha256: "0".repeat(64),
      storageKey: "tenants/2/originals/0/unknown-tenant.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const module = createIngestionModule({
      repository,
      transaction: async (callback) => callback({}),
      processDocument: async () => { throw new Error("Mandant für Job fehlt"); },
      publish: async () => undefined,
    });
    const job = module.jobs.find((item) => item.name === "ingestion.processing.run");
    if (!job || !job.onFailure) throw new Error("Verarbeitungsjob fehlt");
    const failureContext = context(null, { documentId: document.document.id });
    await job.onFailure("Mandant für Job fehlt", failureContext);
    const failed = await repository.getDocument("2", document.document.id);
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("Mandant für Job fehlt");
  });
});
