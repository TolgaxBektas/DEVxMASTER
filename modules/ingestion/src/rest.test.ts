import express from "express";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAuditRepository } from "@xmaster-center/kernel";
import { NoopStorage } from "@xmaster-center/integrations";
import type { AuditRepository } from "@xmaster-center/kernel";
import { MemoryIngestionRepository } from "./memory-repository.js";
import { registerReviewImageRoutes, registerUploadRoute } from "./rest.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function start(permission = true, transaction = async <T>(callback: (db: unknown) => Promise<T>) => callback({})) {
  const app = express();
  app.use((request, _response, next) => {
    (request as typeof request & { auth?: unknown }).auth = {
      tenantId: "1",
      userId: "1",
      displayName: "Test",
      permissions: new Set(permission ? ["ingestion.document.upload", "ingestion.occurrence.read"] : []),
    };
    next();
  });
  const repository = new MemoryIngestionRepository();
  const audit: AuditRepository = new MemoryAuditRepository();
  const storage = new NoopStorage();
  registerUploadRoute(app, {
    db: {},
    repository,
    storage,
    audit,
    auditFor: () => audit,
    transaction,
    publish: async () => undefined,
    enqueue: async () => undefined,
    maxUploadBytes: 32,
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server konnte nicht gestartet werden");
  return { url: `http://127.0.0.1:${address.port}`, repository, storage };
}

function form(body: BlobPart, filename = "document.pdf") {
  const data = new FormData();
  data.append("file", new Blob([body]), filename);
  return data;
}

describe("Ingestion-Upload", () => {
  it("weist fehlendes Upload-Recht ab", async () => {
    const server = await start(false);
    const response = await fetch(`${server.url}/api/ingestion/documents/upload`, {
      method: "POST",
      body: form("%PDF-1.7"),
    });
    expect(response.status).toBe(403);
  });

  it("weist Nicht-PDFs und überschrittene Dateien ab", async () => {
    const server = await start();
    const nonPdf = await fetch(`${server.url}/api/ingestion/documents/upload`, {
      method: "POST",
      body: form("not pdf", "document.txt"),
    });
    const tooLarge = await fetch(`${server.url}/api/ingestion/documents/upload`, {
      method: "POST",
      body: form("%PDF-123456789012345678901234567890"),
    });
    expect(nonPdf.status).toBe(400);
    expect(tooLarge.status).toBe(413);
    expect((await tooLarge.json()).message).toBe("Datei zu groß (maximal 32 Bytes)");
  });

  it("dedupliziert denselben Hash nur innerhalb eines Mandanten", async () => {
    const server = await start();
    const first = await fetch(`${server.url}/api/ingestion/documents/upload`, {
      method: "POST",
      body: form("%PDF-1.7"),
    });
    const second = await fetch(`${server.url}/api/ingestion/documents/upload`, {
      method: "POST",
      body: form("%PDF-1.7"),
    });
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.deduplicated).toBe(false);
    expect(secondBody.deduplicated).toBe(true);
    expect(server.repository.documents).toHaveLength(1);
  });

  it("zeigt bei einem Datenbankfehler keine internen SQL-Details", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await start(true, async () => {
      throw new Error("Failed query: insert into audit_log params: 184");
    });
    const response = await fetch(`${server.url}/api/ingestion/documents/upload`, {
      method: "POST",
      body: form("%PDF-1.7"),
    });
    expect(response.status).toBe(500);
    expect((await response.json()).message).toBe("Upload konnte nicht gespeichert werden");
    expect(server.repository.documents).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("wiederholt die gesamte Transaktion bei einer Audit-Sequenzkollision", async () => {
    let calls = 0;
    const server = await start(true, async (callback) => {
      calls += 1;
      if (calls === 1) {
        const cause = new Error("duplicate");
        Object.assign(cause, { errno: 1062 });
        throw new Error("Audit insert failed", { cause });
      }
      return callback({});
    });
    const response = await fetch(`${server.url}/api/ingestion/documents/upload`, {
      method: "POST",
      body: form("%PDF-1.7", "retry.pdf"),
    });
    expect(response.status).toBe(201);
    expect(calls).toBe(2);
    expect(server.repository.documents).toHaveLength(1);
  });

  it("liefert Ausschnitte nur über die Fundstellenkennung und den eigenen Mandanten", async () => {
    const server = await start();
    const document = await server.repository.createUploadedDocument("1", {
      filename: "review.pdf",
      sha256: "i".repeat(64),
      storageKey: "tenants/1/originals/i/review.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const occurrence = (await server.repository.replaceProcessedDocument("1", document.document.id, [{
      pageNumber: 1,
      text: "Anzeige",
      imageKey: "page.png",
      classification: "MIXED_CONTENT",
      adProbability: 0.9,
      occurrences: [{
        bbox: { x: 0, y: 0, width: 1, height: 1, confidence: 0.9 },
        imageKey: "tenants/1/processed/i/ad.png",
        confidence: 0.9,
        evidence: [],
        company: "Muster",
        preview: "Muster Telefon",
      }],
    }]))[0];
    if (!occurrence) throw new Error("Fundstelle fehlt");
    await server.storage.put("tenants/1/processed/i/ad.png", Buffer.from("image"));
    const response = await fetch(`${server.url}/api/ingestion/occurrences/${occurrence.id}/image`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("image");
    const missing = await fetch(`${server.url}/api/ingestion/occurrences/999/image`);
    expect(missing.status).toBe(404);
  });

  it("verweigert den Bildabruf einer Fundstelle eines fremden Mandanten", async () => {
    const server = await start();
    const document = await server.repository.createUploadedDocument("2", {
      filename: "tenant-2.pdf",
      sha256: "j".repeat(64),
      storageKey: "tenants/2/originals/j/tenant-2.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      origin: "upload",
    });
    const occurrence = (await server.repository.replaceProcessedDocument("2", document.document.id, [{
      pageNumber: 1,
      text: "Anzeige",
      imageKey: "page.png",
      classification: "MIXED_CONTENT",
      adProbability: 0.9,
      occurrences: [{
        bbox: { x: 0, y: 0, width: 1, height: 1, confidence: 0.9 },
        imageKey: "tenants/2/processed/j/ad.png",
        confidence: 0.9,
        evidence: [],
        company: "Fremd",
        preview: "Telefon",
      }],
    }]))[0];
    if (!occurrence) throw new Error("Fundstelle fehlt");
    await server.storage.put("tenants/2/processed/j/ad.png", Buffer.from("secret"));
    const response = await fetch(`${server.url}/api/ingestion/occurrences/${occurrence.id}/image`);
    expect(response.status).toBe(404);
    expect((await response.json()).message).toBe("Fundstelle nicht gefunden.");
  });
});

describe("Ingestion-Prüfbilder", () => {
  it("liefert die Bytes des Prüfdienstes unverändert aus", async () => {
    const app = express();
    app.use((request, _response, next) => {
      (request as typeof request & { auth?: unknown }).auth = {
        tenantId: "1",
        userId: "1",
        displayName: "Test",
        permissions: new Set(["ingestion.review.read"]),
      };
      next();
    });
    const expected = new Uint8Array([137, 80, 78, 71, 0, 255]);
    registerReviewImageRoutes(app, {
      reviewTenantId: "1",
      reviewClient: {
        listOpen: async () => [],
        get: async () => {
          throw new Error("not used");
        },
        decide: async () => {
          throw new Error("not used");
        },
        image: async () => expected,
      },
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server konnte nicht gestartet werden");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingestion/reviews/7/original`);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
  });
});
