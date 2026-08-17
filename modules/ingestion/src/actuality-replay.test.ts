import { describe, expect, it } from "vitest";
import { publishCurrentActualityTransition } from "./actuality-replay.js";

const document = {
  id: 7,
  tenantId: "1",
  sourceId: null,
  filename: "heft.pdf",
  sha256: "a".repeat(64),
  storageKey: "heft.pdf",
  sizeBytes: 10,
  mimeType: "application/pdf",
  origin: "upload",
  state: "processed",
  error: null,
  classification: null,
  actualityStatus: "current" as const,
  actualitySource: "derived" as const,
  actualityDecidedAt: null,
  actualityDecidedBy: null,
};

const occurrence = {
  id: 11,
  documentId: 7,
  pageNumber: 1,
  company: "Muster GmbH",
  preview: "Telefon 0123",
  status: "detected",
};

describe("Aktualitätsübergang", () => {
  it("spielt nur den Übergang nach current wieder ein", async () => {
    const events: Array<Record<string, unknown>> = [];
    const publish = async (event: Record<string, unknown>) => {
      events.push(event);
    };
    await publishCurrentActualityTransition({
      tenantId: "1",
      document,
      previousStatus: "unverified",
      currentStatus: "current",
      occurrences: [occurrence],
      publish,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.idempotencyKey).toContain("unverified-current");
    await publishCurrentActualityTransition({
      tenantId: "1",
      document,
      previousStatus: "current",
      currentStatus: "outdated",
      occurrences: [occurrence],
      publish,
    });
    expect(events).toHaveLength(1);
  });
});
