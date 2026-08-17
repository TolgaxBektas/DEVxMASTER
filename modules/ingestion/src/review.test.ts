import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@xmaster-center/contracts";
import { MemoryAuditRepository } from "@xmaster-center/kernel";
import { MemoryIngestionRepository } from "./memory-repository.js";
import { createIngestionRouter } from "./router.js";
import { createPifReviewClient } from "./review-client.js";

const review = {
  id: 7,
  reason: "Generativ erzeugt",
  data_source: "xdata_nb_high_quality",
  status: "pending",
  reviewed_at: null,
  document_id: 2,
  ad_id: 3,
  page: 4,
  company: {
    id: 1,
    name: "Test GmbH",
    extracted_values: {},
    evidence: {},
    verification: {},
  },
  bbox: [1, 2, 3, 4],
  restoration: {
    review_status: "pending",
    geometry_quality_status: "external",
    model_name: "gpt-image-2",
    plan_digest: "digest",
  },
  images: { original_available: true, restored_available: true },
  created_at: null,
} as const;

function setup(tenantId = "1") {
  const audit = new MemoryAuditRepository();
  const repository = new MemoryIngestionRepository();
  const client = {
    listOpen: vi.fn(async () => [review]),
    get: vi.fn(async () => review),
    decide: vi.fn(async () => ({ id: 7, status: "approved", note: null, next_open_id: null })),
    image: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
  const context: AuthContext = {
    user: { id: "5", email: "review@example.invalid", displayName: "Reviewer" },
    tenantId,
    permissions: new Set(["ingestion.review.read", "ingestion.review.decide"]),
    provider: "local",
  };
  const caller = createIngestionRouter(
    repository,
    async () => undefined,
    undefined,
    undefined,
    client,
    "1",
    audit,
  ).createCaller({ auth: context });
  return { caller, client, context, audit };
}

describe("Ingestion-Prüfung", () => {
  it("erlaubt Lesen ohne Entscheidungsrecht", async () => {
    const { caller, context } = setup();
    context.permissions = new Set(["ingestion.review.read"]);
    await expect(caller.review.list()).resolves.toMatchObject({ items: [review] });
    await expect(caller.review.decide({ id: 7, decision: "approve" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("reicht den Quellfilter an die Data Factory weiter", async () => {
    const { caller, client } = setup();
    await caller.review.list({ data_source: "xdata_germany" });
    expect(client.listOpen).toHaveBeenCalledWith("xdata_germany");
  });

  it("grenzt fremde Mandanten ab", async () => {
    const { caller, context, client } = setup();
    context.tenantId = "2";
    await expect(caller.review.list()).resolves.toMatchObject({
      items: [],
      message: "Für diesen Mandanten sind keine Data-Factory-Prüffälle konfiguriert.",
    });
    expect(client.listOpen).not.toHaveBeenCalled();
  });

  it("schreibt bei einer Entscheidung einen Audit-Eintrag", async () => {
    const { caller, audit } = setup();
    await caller.review.decide({ id: 7, decision: "reject", note: "Bitte ablehnen" });
    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry).toMatchObject({
      action: "ingestion.review.decided",
      entityType: "ingestion_review",
      entityId: 7,
      tenantId: "1",
    });
    expect(JSON.parse(entry.detailsJson ?? "{}")).toMatchObject({
      decision: "reject",
      note: "Bitte ablehnen",
    });
  });

  it("liefert eine deutsche Meldung bei nicht erreichbarem Prüfdienst", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection refused");
    }));
    try {
      const client = createPifReviewClient({
        baseUrl: "http://127.0.0.1:9",
        serviceToken: "secret",
      });
      await expect(client.listOpen()).rejects.toThrow("Prüfdienst ist nicht erreichbar");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
