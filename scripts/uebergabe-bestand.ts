import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import {
  appendAudit,
  auditLog,
  createDbFactory,
  createDrizzleAuditRepository,
  jobs,
  parseEnv,
} from "../packages/kernel/src/index.ts";
import { DrizzleQueueRepository, LeaseQueue } from "../packages/jobs/src/index.ts";
import {
  areas,
  documents,
  occurrences,
  sources,
} from "../modules/ingestion/src/schema.ts";
import {
  categorizeBestandHandoffs,
  parseBestandHandoffArguments,
} from "../modules/ingestion/src/bestand-uebergabe.ts";

async function main() {
  const { tenantId, ags, apply } = parseBestandHandoffArguments(process.argv.slice(2));
  const factory = createDbFactory(parseEnv());

  try {
    const db = factory.get();
    const area = (await db.select({ name: areas.name })
      .from(areas)
      .where(and(
        eq(areas.tenantId, tenantId),
        eq(areas.ags, ags),
      ))
      .limit(1))[0];
    if (!area) throw new Error(`Gebiet ${ags} wurde nicht gefunden.`);

    const rows = await db.select({
      id: occurrences.id,
      alreadyHandedOff: sql<number>`EXISTS (
        SELECT 1
        FROM ${auditLog}
        WHERE ${auditLog.tenantId} = ${tenantId}
          AND ${auditLog.action} = 'ingestion.occurrence.handoff'
          AND BINARY ${auditLog.entityId} = BINARY CAST(${occurrences.id} AS CHAR)
          AND JSON_EXTRACT(${auditLog.detailsJson}, '$.skipped') IS NULL
      )`.as("alreadyHandedOff"),
      alreadyQueued: sql<number>`EXISTS (
        SELECT 1
        FROM ${jobs}
        WHERE ${jobs.name} = 'ingestion.handoff.artwork'
          AND ${jobs.tenantId} = ${tenantId}
          AND ${jobs.status} IN ('pending', 'processing')
          AND JSON_EXTRACT(${jobs.payload}, '$.occurrenceId') = ${occurrences.id}
      )`.as("alreadyQueued"),
    })
      .from(occurrences)
      .innerJoin(documents, and(
        eq(documents.id, occurrences.documentId),
        eq(documents.tenantId, occurrences.tenantId),
      ))
      .innerJoin(sources, and(
        eq(sources.id, documents.sourceId!),
        eq(sources.tenantId, occurrences.tenantId),
      ))
      .innerJoin(areas, and(
        eq(areas.id, sources.areaId!),
        eq(areas.tenantId, occurrences.tenantId),
      ))
      .where(and(
        eq(occurrences.tenantId, tenantId),
        eq(areas.ags, ags),
        eq(occurrences.status, "detected"),
        isNotNull(occurrences.imageKey),
        sql`JSON_SEARCH(${occurrences.evidence}, 'one', 'positiv:%') IS NOT NULL`,
      ))
      .orderBy(asc(occurrences.id));

    const categorized = categorizeBestandHandoffs(rows.map((row) => ({
      id: row.id,
      alreadyHandedOff: Number(row.alreadyHandedOff) > 0,
      alreadyQueued: Number(row.alreadyQueued) > 0,
    })));
    const enqueued = categorized.toEnqueue.length;

    if (apply) {
      const queue = new LeaseQueue(new DrizzleQueueRepository(db));
      for (const occurrence of categorized.toEnqueue) {
        await queue.enqueue({
          name: "ingestion.handoff.artwork",
          tenantId: String(tenantId),
          payload: { occurrenceId: occurrence.id },
        });
      }

      if (enqueued > 0) {
        await appendAudit(createDrizzleAuditRepository(db), {
          tenantId: String(tenantId),
          action: "ingestion.handoff.bestand",
          entityType: "ingestion_area",
          entityId: ags,
          actorId: null,
          actorName: "Bestandsübergabe",
          detailsJson: JSON.stringify({
            enqueued,
            alreadyHandedOff: categorized.alreadyHandedOff.length,
            alreadyQueued: categorized.alreadyQueued.length,
            candidates: categorized.candidates.length,
          }),
        });
      }
    }

    console.log(`Gebiet: ${ags} ${area.name}`);
    console.log(`Kandidaten: ${categorized.candidates.length}`);
    console.log(`Bereits übergeben: ${categorized.alreadyHandedOff.length}`);
    console.log(`Bereits eingereiht: ${categorized.alreadyQueued.length}`);
    console.log(`Einzureihen: ${enqueued}`);
    console.log(apply ? "Einreihung angewendet." : "Probelauf ohne Schreibzugriff.");
  } finally {
    await factory.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
