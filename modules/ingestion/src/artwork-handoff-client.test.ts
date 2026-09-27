import { describe, expect, it, vi } from "vitest";
import {
  createArtworkHandoffClient,
  type ArtworkHandoffManifest,
} from "./artwork-handoff-client.js";

const manifest: ArtworkHandoffManifest = {
  company_name: "Muster GmbH",
  advertiser_proof: ["positiv:p2"],
  evidence: ["geometry", "positiv:p2"],
  provenance: {
    data_source: "xdata_germany",
    center_tenant_id: 1,
    center_occurrence_id: 2,
    document_sha256: "a".repeat(64),
    page: 3,
    bbox: [0.1, 0.2, 0.3, 0.4],
  },
};

describe("Artwork-Übergabeclient", () => {
  it("sendet den Ausschnitt und das Manifest als Multipart", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(body.get("manifest")).toBe(JSON.stringify(manifest));
      const original = body.get("original");
      expect(original).toBeInstanceOf(File);
      expect(await (original as File).arrayBuffer()).toEqual(
        new Uint8Array([1, 2, 3]).buffer,
      );
      return new Response(JSON.stringify({
        document_id: 10,
        ad_id: 20,
        review_status: "pending",
        deduplicated: false,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(createArtworkHandoffClient({
        baseUrl: "http://artwork/",
        serviceToken: "token",
      }).submit({
        original: new Uint8Array([1, 2, 3]),
        manifest,
      })).resolves.toEqual({
        documentId: 10,
        adId: 20,
        reviewStatus: "pending",
        deduplicated: false,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://artwork/imports/print-find",
        expect.objectContaining({
          headers: { "x-service-token": "token" },
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("meldet Nichterreichbarkeit und Ablehnung auf Deutsch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection refused");
    }));
    try {
      await expect(createArtworkHandoffClient({
        baseUrl: "http://artwork",
        serviceToken: "token",
      }).submit({ original: new Uint8Array([1]), manifest }))
        .rejects.toThrow("Bearbeitungsdienst ist nicht erreichbar");
    } finally {
      vi.unstubAllGlobals();
    }

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nein", { status: 422 })));
    try {
      await expect(createArtworkHandoffClient({
        baseUrl: "http://artwork",
        serviceToken: "token",
      }).submit({ original: new Uint8Array([1]), manifest }))
        .rejects.toThrow("Bearbeitungsdienst hat die Übergabe abgelehnt");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("bricht eine nicht antwortende Übergabe nach dem Zeitlimit ab", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      })
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(createArtworkHandoffClient({
        baseUrl: "http://artwork",
        serviceToken: "token",
        timeoutMs: 10,
      }).submit({ original: new Uint8Array([1]), manifest }))
        .rejects.toThrow("Bearbeitungsdienst hat nicht rechtzeitig geantwortet");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("bricht einen nicht antwortenden Antwortkörper nach dem Zeitlimit ab", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return {
        ok: true,
        json: () => new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const startedAt = Date.now();
      await expect(createArtworkHandoffClient({
        baseUrl: "http://artwork",
        serviceToken: "token",
        timeoutMs: 20,
      }).submit({ original: new Uint8Array([1]), manifest }))
        .rejects.toThrow("Bearbeitungsdienst hat nicht rechtzeitig geantwortet");
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gibt einen fehlerhaften Antwortkörper unverändert weiter", async () => {
    const syntaxError = new SyntaxError("Ungültiges JSON");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: () => {
        throw syntaxError;
      },
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(createArtworkHandoffClient({
        baseUrl: "http://artwork",
        serviceToken: "token",
      }).submit({ original: new Uint8Array([1]), manifest }))
        .rejects.toBe(syntaxError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reicht ein externes Abbruchsignal an die Übergabe weiter", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      })
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const request = createArtworkHandoffClient({
        baseUrl: "http://artwork",
        serviceToken: "token",
        timeoutMs: 1_000,
      }).submit({ original: new Uint8Array([1]), manifest }, controller.signal);
      controller.abort();
      await expect(request).rejects.toThrow("Bearbeitungsdienst ist nicht erreichbar");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://artwork/imports/print-find",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
