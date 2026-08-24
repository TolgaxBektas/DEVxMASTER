import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAuditRepository } from "@xmaster-center/kernel";
import { NoopStorage } from "@xmaster-center/integrations";
import { MemoryIngestionRepository } from "./memory-repository.js";
import { persistDocumentBytes } from "./rest.js";
import { scanWatchFolder } from "./module.js";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function setup() {
  const folder = await mkdtemp(join(tmpdir(), "xmaster-watchfolder-"));
  folders.push(folder);
  const repository = new MemoryIngestionRepository();
  const storage = new NoopStorage();
  const audit = new MemoryAuditRepository();
  const enqueue = vi.fn(async (_input: {
    name: string;
    tenantId?: string | null;
    payload: unknown;
  }) => undefined);
  const observations = new Map<string, { size: number; observations: number }>();
  const persist = (input: Parameters<typeof persistDocumentBytes>[1]) => persistDocumentBytes({
    db: {},
    repository,
    storage,
    audit,
    transaction: async (callback) => callback({}),
    publish: async () => undefined,
    enqueue,
    maxUploadBytes: 1024 * 1024,
  }, input);
  return { folder, repository, enqueue, observations, persist };
}

async function scan(state: Awaited<ReturnType<typeof setup>>) {
  await scanWatchFolder({
    folderPath: state.folder,
    tenantId: "1",
    observations: state.observations,
    persist: state.persist,
    enqueue,
  });

  async function enqueue(input: { name: string; tenantId: string; payload: unknown }) {
    await state.enqueue(input);
  }
}

describe("Ingestion-Überwachungsordner", () => {
  it("wartet auf zwei stabile Größenbeobachtungen und verarbeitet danach", async () => {
    const state = await setup();
    const source = join(state.folder, "anzeige.pdf");
    await writeFile(source, "%PDF-1.7\npart");
    await scan(state);
    expect(state.repository.documents).toHaveLength(0);
    await writeFile(source, "%PDF-1.7\nvollständig");
    await scan(state);
    expect(state.repository.documents).toHaveLength(0);
    await scan(state);
    expect(state.repository.documents).toHaveLength(1);
    expect(state.enqueue).toHaveBeenCalledWith({
      name: "ingestion.processing.run",
      tenantId: "1",
      payload: { documentId: 1 },
    });
    expect(await readFile(join(state.folder, "erfolgreich", "anzeige.pdf"), "utf8"))
      .toBe("%PDF-1.7\nvollständig");
  });

  it("trennt Deduplizierung und fehlerhafte Dateien", async () => {
    const state = await setup();
    const first = join(state.folder, "erste.pdf");
    await writeFile(first, "%PDF-1.7\nidentisch");
    await scan(state);
    await scan(state);
    await writeFile(join(state.folder, "zweite.pdf"), "%PDF-1.7\nidentisch");
    await scan(state);
    await scan(state);
    expect(state.repository.documents).toHaveLength(1);
    expect((await readdir(join(state.folder, "bereits-vorhanden")))).toContain("zweite.pdf");

    await writeFile(join(state.folder, "fehler.pdf"), "kein PDF");
    await scan(state);
    await scan(state);
    expect((await readdir(join(state.folder, "fehlerhaft")))).toContain("fehler.pdf");
  });

  it("ist bei nicht konfiguriertem Ordner deaktiviert", async () => {
    const persist = vi.fn();
    await scanWatchFolder({
      folderPath: " ",
      tenantId: "1",
      observations: new Map(),
      persist,
      enqueue: vi.fn(),
    });
    expect(persist).not.toHaveBeenCalled();
  });
});
