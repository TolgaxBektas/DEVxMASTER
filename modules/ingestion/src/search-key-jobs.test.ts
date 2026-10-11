import { describe, expect, it, vi } from "vitest";
import { MemoryIngestionRepository } from "./memory-repository.js";
import { createIngestionModule } from "./module.js";

const context = (tenantId: string, payload: unknown) => ({
  job: { tenantId, payload },
  lockLease: async () => true,
});

async function createArea(repository: MemoryIngestionRepository) {
  return repository.upsertArea("1", {
    level: "district",
    ags: "01001",
    name: "Alpha",
    stateName: "Land",
    orderIndex: 1,
    kind: "Landkreis",
    status: "pending",
    lastRunAt: null,
    startedAt: null,
    nextDueAt: null,
    lastError: null,
    foundSources: 0,
  });
}

describe("feste Suchschlüssel-Jobs", () => {
  it("seedet Begriffe und Schlüssel idempotent, ohne bestehende Begriffe zu ändern", async () => {
    const repository = new MemoryIngestionRepository();
    await repository.ensureSearchTerms("1", [{ term: "Seniorenwegweiser", priority: 1 }]);
    const term = (await repository.listSearchTerms("1"))[0];
    if (!term) throw new Error("Suchbegriff fehlt");
    await repository.setSearchTermActive("1", term.id, false);
    await repository.ensureSearchTerms("1", [{ term: "Seniorenwegweiser", priority: 3 }]);
    const key = {
      areaId: 1,
      keyType: "kreis" as const,
      term: "Seniorenwegweiser",
      scope: "Alpha",
      query: "Seniorenwegweiser Landkreis Alpha",
    };
    const first = await repository.insertSearchKeys("1", [key]);
    const second = await repository.insertSearchKeys("1", [key]);
    expect(await repository.listSearchTerms("1")).toMatchObject([
      { term: "Seniorenwegweiser", priority: 1, active: false, origin: "vorgabe" },
    ]);
    expect(first.kreis).toEqual({ inserted: 1, existing: 0 });
    expect(second.kreis).toEqual({ inserted: 0, existing: 1 });
  });

  it("verarbeitet pending vor due, protokolliert Treffer und reiht den Rest erneut ein", async () => {
    const repository = new MemoryIngestionRepository();
    const area = await createArea(repository);
    await repository.createSearchTerm("1", {
      term: "Primär", priority: 1, active: true, origin: "manuell",
    });
    await repository.createSearchTerm("1", {
      term: "Sekundär", priority: 2, active: true, origin: "manuell",
    });
    await repository.createSearchTerm("1", {
      term: "Fällig", priority: 1, active: true, origin: "manuell",
    });
    await repository.insertSearchKeys("1", [
      { areaId: area.id, keyType: "kreis", term: "Primär", scope: "Alpha", query: "Primär Landkreis Alpha" },
      { areaId: area.id, keyType: "verwaltung", term: "Sekundär", scope: "Amt Alpha", query: "Sekundär Amt Alpha" },
      { areaId: area.id, keyType: "verwaltung", term: "Fällig", scope: "Amt Alpha", query: "Fällig Amt Alpha" },
    ]);
    const dueKey = repository.searchKeys.find((key) => key.term === "Fällig");
    if (!dueKey) throw new Error("Fälliger Suchschlüssel fehlt");
    await repository.updateSearchKey("1", dueKey.id, {
      status: "done",
      lastSearchedAt: new Date(Date.now() - 2 * 86_400_000),
      nextDueAt: new Date(Date.now() - 86_400_000),
    });
    const searches: string[] = [];
    const enqueued: string[] = [];
    const module = createIngestionModule({
      repository,
      publish: async () => undefined,
      enqueue: async ({ name }) => { enqueued.push(name); },
      discoverProposals: async ({ searchTerms, seedPages, archiveDomains, maxResults, areaName }) => {
        expect(seedPages).toEqual([]);
        expect(archiveDomains).toEqual([]);
        expect(maxResults).toBe(10);
        expect(areaName).toBe("Alpha");
        searches.push(searchTerms[0] ?? "");
        return {
          proposals: [
            { url: "https://example.test/brochure.pdf", score: 1, metadata: {} },
            { url: "https://example.test/index.html", score: 1, metadata: {} },
          ],
          searchHits: [{ term: searchTerms[0] ?? "", count: 7, error: null }],
        };
      },
    });
    const job = module.jobs.find((item) => item.name === "ingestion.search_keys.run");
    if (!job) throw new Error("Suchschlüssel-Lauf fehlt");
    await job.handle({ limit: 1 }, context("1", {}));

    expect(searches).toEqual(["Primär Landkreis Alpha"]);
    expect(enqueued).toEqual(["ingestion.search_keys.run"]);
    const keys = await repository.listSearchKeysForRun("1", new Date(Date.now() + 100 * 86_400_000), 10);
    const primary = repository.searchKeys.find((key) => key.term === "Primär");
    expect(primary).toMatchObject({
      status: "done",
      lastHitCount: 7,
      lastPdfCount: 1,
      lastNewSources: 2,
      totalNewSources: 2,
      runCount: 1,
      lastError: null,
    });
    expect(primary?.nextDueAt?.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(primary?.nextDueAt?.getTime()).toBeLessThan(Date.now() + 31 * 86_400_000);
    expect(keys.map((item) => item.key.term)).toEqual(["Sekundär", "Fällig", "Primär"]);
    expect((await repository.listSources("1"))[0]?.metadata).toMatchObject({
      search_key: "Primär Landkreis Alpha",
    });
  });

  it("setzt Fehler auf einen Tag zurück und zählt sie nicht als durchsucht", async () => {
    const repository = new MemoryIngestionRepository();
    const area = await createArea(repository);
    await repository.createSearchTerm("1", {
      term: "Primär", priority: 1, active: true, origin: "manuell",
    });
    await repository.insertSearchKeys("1", [{
      areaId: area.id,
      keyType: "ort",
      term: "Primär",
      scope: "Dorf",
      query: "Primär Dorf",
    }]);
    const module = createIngestionModule({
      repository,
      publish: async () => undefined,
      discoverProposals: async ({ searchTerms }) => ({
        proposals: [],
        searchHits: [{ term: searchTerms[0] ?? "", count: 0, error: "Suchanbieter ausgefallen" }],
      }),
    });
    const job = module.jobs.find((item) => item.name === "ingestion.search_keys.run");
    if (!job) throw new Error("Suchschlüssel-Lauf fehlt");
    await job.handle({}, context("1", {}));
    const key = repository.searchKeys[0];
    if (!key) throw new Error("Suchschlüssel fehlt");
    const coverage = await repository.listSearchKeyCoverage("1");
    expect(key).toMatchObject({
      status: "error",
      runCount: 0,
      lastSearchedAt: null,
      lastError: "Suchanbieter ausgefallen",
    });
    expect(key.nextDueAt?.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(key.nextDueAt?.getTime()).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000);
    expect(coverage).toMatchObject([
      { areaId: area.id, keyType: "ort", total: 1, searched: 0, errors: 1 },
    ]);
  });

  it("plant erfolgreiche Suchen ohne PDF 90 Tage später und reiht nichts nach", async () => {
    const repository = new MemoryIngestionRepository();
    const area = await createArea(repository);
    await repository.createSearchTerm("1", {
      term: "Primär", priority: 1, active: true, origin: "manuell",
    });
    await repository.insertSearchKeys("1", [{
      areaId: area.id,
      keyType: "kreis",
      term: "Primär",
      scope: "Alpha",
      query: "Primär Landkreis Alpha",
    }]);
    const enqueue = vi.fn(async () => undefined);
    const module = createIngestionModule({
      repository,
      publish: async () => undefined,
      enqueue,
      discoverProposals: async ({ searchTerms }) => ({
        proposals: [],
        searchHits: [{ term: searchTerms[0] ?? "", count: 3, error: null }],
      }),
    });
    const job = module.jobs.find((item) => item.name === "ingestion.search_keys.run");
    if (!job) throw new Error("Suchschlüssel-Lauf fehlt");
    await job.handle({}, context("1", {}));
    const key = repository.searchKeys[0];
    if (!key) throw new Error("Suchschlüssel fehlt");
    expect(key).toMatchObject({
      status: "done",
      lastHitCount: 3,
      lastPdfCount: 0,
      runCount: 1,
      lastError: null,
    });
    expect(key.nextDueAt?.getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    expect(key.nextDueAt?.getTime()).toBeLessThan(Date.now() + 91 * 86_400_000);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
