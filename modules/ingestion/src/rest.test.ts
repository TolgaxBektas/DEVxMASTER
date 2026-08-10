import express from "express";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAuditRepository } from "@xmaster-center/kernel";
import { NoopStorage } from "@xmaster-center/integrations";
import type { AuditRepository } from "@xmaster-center/kernel";
import { MemoryIngestionRepository } from "./memory-repository.js";
import { registerUploadRoute } from "./rest.js";

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
      permissions: new Set(permission ? ["ingestion.document.upload"] : []),
    };
    next();
  });
  const repository = new MemoryIngestionRepository();
  const audit: AuditRepository = new MemoryAuditRepository();
  registerUploadRoute(app, {
    db: {},
    repository,
    storage: new NoopStorage(),
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
  return { url: `http://127.0.0.1:${address.port}`, repository };
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
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
