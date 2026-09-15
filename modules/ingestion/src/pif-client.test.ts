import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { NoopStorage } from "@xmaster-center/integrations";
import { createPifProcessor } from "./pif-client.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function startServer(
  handler: RequestListener,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server konnte nicht gestartet werden");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function storageWithPdf(bytes: Uint8Array) {
  const storage = new NoopStorage();
  storage.objects.set("original.pdf", bytes);
  return storage;
}

describe("PIF-Prozessclient", () => {
  it("sendet Multipart-Daten und mappt nullable Seitenbilder", async () => {
    const pdf = new Uint8Array([37, 80, 68, 70, 45, 49]);
    const outputPrefix = "tenants/1/processed/example";
    const { url } = await startServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        expect(request.headers["content-type"]).toMatch(
          /^multipart\/form-data; boundary=----xmaster/,
        );
        expect(body.includes(Buffer.from(pdf))).toBe(true);
        expect(body.toString("utf8")).toContain(outputPrefix);
        setTimeout(() => {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              pages: [
                {
                  page_number: 1,
                  text: "Redaktion",
                  image_key: null,
                  classification: "EDITORIAL",
                  ad_probability: 0.01,
                  occurrences: [],
                },
                {
                  page_number: 2,
                  text: "Anzeige",
                  image_key: "tenants/1/processed/example/page-0002.png",
                  classification: "ADVERTISEMENT",
                  ad_probability: 0.99,
                  occurrences: [],
                },
              ],
            }),
          );
        }, 300);
      });
    });
    const processor = createPifProcessor({
      storage: storageWithPdf(pdf),
      baseUrl: url,
      serviceToken: "token",
    });

    await expect(
      processor({ storageKey: "original.pdf", outputPrefix }),
    ).resolves.toEqual([
      {
        pageNumber: 1,
        text: "Redaktion",
        imageKey: null,
        classification: "EDITORIAL",
        adProbability: 0.01,
        titleCandidates: [],
        occurrences: [],
      },
      {
        pageNumber: 2,
        text: "Anzeige",
        imageKey: "tenants/1/processed/example/page-0002.png",
        classification: "ADVERTISEMENT",
        adProbability: 0.99,
        titleCandidates: [],
        occurrences: [],
      },
    ]);
  });

  it("reicht HTTP-Fehler an responseErrorMessage weiter", async () => {
    const { url } = await startServer((_request, response) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ detail: "PIF-intern fehlgeschlagen" }));
    });
    const processor = createPifProcessor({
      storage: storageWithPdf(new Uint8Array([1, 2, 3])),
      baseUrl: url,
      serviceToken: "token",
    });

    await expect(
      processor({ storageKey: "original.pdf", outputPrefix: "prefix" }),
    ).rejects.toThrow("PIF-intern fehlgeschlagen");
  });

  it("meldet Transportfehler als nicht erreichbaren PIF", async () => {
    const { server, url } = await startServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    servers.splice(servers.indexOf(server), 1);
    const processor = createPifProcessor({
      storage: storageWithPdf(new Uint8Array([1, 2, 3])),
      baseUrl: url,
      serviceToken: "token",
    });

    await expect(
      processor({ storageKey: "original.pdf", outputPrefix: "prefix" }),
    ).rejects.toThrow("PDF-Verarbeitung ist nicht erreichbar");
  });
});
