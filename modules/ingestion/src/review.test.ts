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
    deferred_channels: [],
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
    openSummary: vi.fn(async () => ({ total: 1, areas: [] })),
    get: vi.fn(async () => review),
    decide: vi.fn(async () => ({ id: 7, status: "approved", note: null, next_open_id: null })),
    withdraw: vi.fn(async () => 0),
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

  it("reicht Quell- und Erkennungsfilter an die Data Factory weiter", async () => {
    const { caller, client } = setup();
    await caller.review.list({
      data_source: "xdata_germany",
      area_ags: "09162",
      detector: "run50",
      limit: 100,
      offset: 200,
    });
    expect(client.listOpen).toHaveBeenCalledWith({
      dataSource: "xdata_germany",
      areaAgs: "09162",
      detector: "run50",
      limit: 100,
      offset: 200,
    });
  });

  it("liefert Zusammenfassung für konfigurierte Prüffälle", async () => {
    const { caller, client } = setup();
    await expect(caller.review.summary({
      data_source: "xdata_germany",
      detector: "run50",
    })).resolves.toMatchObject({
      enabled: true,
      total: 1,
      areas: [],
    });
    expect(client.openSummary).toHaveBeenCalledWith("xdata_germany", "run50");
  });

  it("grenzt fremde Mandanten ab", async () => {
    const { caller, context, client } = setup();
    context.tenantId = "2";
    await expect(caller.review.list()).resolves.toMatchObject({
      items: [],
      message: "Für diesen Mandanten sind keine Data-Factory-Prüffälle konfiguriert.",
    });
    await expect(caller.review.summary()).resolves.toMatchObject({
      enabled: true,
      total: 0,
      areas: [],
    });
    expect(client.listOpen).not.toHaveBeenCalled();
    expect(client.openSummary).not.toHaveBeenCalled();
  });

  it("liefert eine deaktivierte leere Zusammenfassung ohne Prüfdienst", async () => {
    const caller = createIngestionRouter(
      new MemoryIngestionRepository(),
      async () => undefined,
    ).createCaller({
      auth: {
        user: { id: "5", email: "review@example.invalid", displayName: "Reviewer" },
        tenantId: "1",
        permissions: new Set(["ingestion.review.read"]),
        provider: "local",
      },
    });
    await expect(caller.review.summary()).resolves.toMatchObject({
      enabled: false,
      total: 0,
      areas: [],
    });
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

  it("überträgt Prüfungsfilter, Seitengröße und Offset als Queryparameter", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requests.push(url);
      const body = url.includes("/summary")
        ? { total: 0, areas: [] }
        : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    try {
      const client = createPifReviewClient({
        baseUrl: "http://pif.test",
        serviceToken: "test-token",
      });
      await client.listOpen({
        dataSource: "xdata_germany",
        areaAgs: "09162",
        detector: "run50",
        limit: 100,
        offset: 200,
      });
      await client.openSummary("xdata_germany", "run50");

      const listUrl = new URL(requests[0] ?? "");
      expect(listUrl.pathname).toBe("/api/v1/reviews/open");
      expect([...listUrl.searchParams.entries()]).toEqual([
        ["data_source", "xdata_germany"],
        ["area_ags", "09162"],
        ["detector", "run50"],
        ["limit", "100"],
        ["offset", "200"],
      ]);
      const summaryUrl = new URL(requests[1] ?? "");
      expect(summaryUrl.pathname).toBe("/api/v1/reviews/open/summary");
      expect(summaryUrl.searchParams.get("data_source")).toBe("xdata_germany");
      expect(summaryUrl.searchParams.get("detector")).toBe("run50");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("teilt Review-Rückzüge in Anfragen mit höchstens 2.000 IDs", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      const idCount = (requests.at(-1)?.body as { center_occurrence_ids: number[] })
        .center_occurrence_ids.length;
      return new Response(JSON.stringify({ withdrawn: idCount }), { status: 200 });
    }));
    try {
      const client = createPifReviewClient({
        baseUrl: "http://pif.test",
        serviceToken: "test-token",
      });
      await expect(client.withdraw(7, Array.from({ length: 2001 }, (_, index) => index + 1)))
        .resolves.toBe(2001);
      expect(requests).toHaveLength(2);
      expect(requests.map(({ body }) =>
        (body as { center_occurrence_ids: number[] }).center_occurrence_ids.length,
      )).toEqual([2000, 1]);
      expect(requests.map(({ body }) =>
        (body as { center_tenant_id: number }).center_tenant_id,
      )).toEqual([7, 7]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
