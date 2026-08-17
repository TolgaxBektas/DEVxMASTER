import type { EventExecutor } from "@xmaster-center/kernel";
import { occurrenceFingerprint, type IngestionDocument, type IngestionOccurrence } from "./repository.js";
import type { ActualityStatus } from "./actuality.js";

export async function publishCurrentActualityTransition(input: {
  tenantId: string;
  document: IngestionDocument;
  previousStatus: ActualityStatus;
  currentStatus: ActualityStatus;
  occurrences: IngestionOccurrence[];
  publish: (event: {
    name: string;
    tenantId: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }, executor?: EventExecutor) => Promise<unknown>;
  executor?: EventExecutor;
}) {
  if (input.previousStatus === input.currentStatus || input.currentStatus !== "current") return;
  for (const occurrence of input.occurrences.filter((item) => item.documentId === input.document.id)) {
    await input.publish({
      name: "advertisement.detected",
      tenantId: input.tenantId,
      aggregateType: "occurrence",
      aggregateId: String(occurrence.id),
      payload: {
        occurrenceId: occurrence.id,
        documentId: input.document.id,
        company: occurrence.company,
        preview: occurrence.preview,
        actualityStatus: "current",
      },
      idempotencyKey: [
        "advertisement.detected:actuality-transition",
        input.tenantId,
        `${input.previousStatus}-current`,
        input.document.sha256,
        occurrenceFingerprint(occurrence),
      ].join(":"),
    }, input.executor);
  }
}
