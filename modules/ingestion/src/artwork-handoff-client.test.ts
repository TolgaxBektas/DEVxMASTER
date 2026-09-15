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
});
