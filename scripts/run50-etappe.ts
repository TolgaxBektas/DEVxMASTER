import {
  and,
  asc,
  eq,
  inArray,
  notExists,
  sql,
} from "drizzle-orm";
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
  pages,
  sources,
} from "../modules/ingestion/src/schema.ts";
import {
  parseRun50EtappeArguments,
  run50EtappeTargetPages,
  selectRun50EtappeDocuments,
} from "../modules/ingestion/src/run50-etappe.ts";

async function main() {
  const { tenantId, etappe, anteil, apply } =
    parseRun50EtappeArguments(process.argv.slice(2));
  const factory = createDbFactory(parseEnv());

  try {
    const db = factory.get();
    const totalRows = await db.select({
      pages: sql<number>`COUNT(${pages.id})`,
    })
      .from(documents)
      .leftJoin(pages, eq(pages.documentId, documents.id))
      .where(and(
        eq(documents.tenantId, tenantId),
        eq(documents.state, "processed"),
      ));
    const totalProcessedPages = Number(totalRows[0]?.pages ?? 0);
    const targetPages = run50EtappeTargetPages(totalProcessedPages, anteil);
    const rows = await db.select({
      documentId: documents.id,
      sha256: documents.sha256,
      filename: documents.filename,
      ags: areas.ags,
      areaName: areas.name,
      pages: sql<number>`COUNT(${pages.id})`,
    })
      .from(documents)
      .innerJoin(sources, and(
        eq(sources.id, documents.sourceId!),
        eq(sources.tenantId, tenantId),
      ))
      .innerJoin(areas, and(
        eq(areas.id, sources.areaId!),
        eq(areas.tenantId, tenantId),
      ))
      .leftJoin(pages, eq(pages.documentId, documents.id))
      .where(and(
        eq(documents.tenantId, tenantId),
        eq(documents.state, "processed"),
        notExists(db.select({ id: occurrences.id })
          .from(occurrences)
          .where(and(
            eq(occurrences.tenantId, tenantId),
            eq(occurrences.documentId, documents.id),
            eq(occurrences.status, "approved"),
          ))),
        notExists(db.select({ id: auditLog.id })
          .from(auditLog)
          .where(and(
            eq(auditLog.tenantId, tenantId),
            eq(auditLog.action, "ingestion.run50_etappe.document"),
            sql`BINARY ${auditLog.entityId} = BINARY CAST(${documents.id} AS CHAR)`,
          ))),
      ))
      .groupBy(
        documents.id,
        documents.sha256,
        documents.filename,
        areas.ags,
        areas.name,
      )
      .orderBy(asc(areas.ags), asc(documents.sha256), asc(documents.id));
    const candidates = rows.map((row) => ({
      documentId: row.documentId,
      sha256: row.sha256,
      filename: row.filename,
      ags: row.ags,
      areaName: row.areaName,
      pages: Number(row.pages),
    }));
    const selected = selectRun50EtappeDocuments(candidates, targetPages, etappe);
    const selectedPages = selected.reduce((sum, item) => sum + item.pages, 0);

    console.log(`Etappe: ${etappe}`);
    console.log(`Anteil: ${anteil}%`);
    console.log(`Zielseiten: ${targetPages}`);
    console.log(`Dokumente: ${selected.length}`);
    console.log(`Seiten: ${selectedPages}`);
    console.log(`Gebiete: ${new Set(selected.map((item) => item.ags)).size}`);
    console.log(`Geschätzte Kosten: ${(selectedPages * 0.021).toFixed(2)} USD`);
    console.log(["document_id", "ags", "area name", "pages", "filename"].join("\t"));
    for (const candidate of selected) {
      console.log([
        candidate.documentId,
        candidate.ags,
        candidate.areaName,
        candidate.pages,
        candidate.filename,
      ].join("\t"));
    }

    if (apply) {
      const queue = new LeaseQueue(new DrizzleQueueRepository(db));
      let enqueued = 0;
      let skipped = 0;
      for (const candidate of selected) {
        const applied = await db.transaction(async (transaction) => {
          const stillEligible = await transaction.select({ id: documents.id })
            .from(documents)
            .innerJoin(sources, and(
              eq(sources.id, documents.sourceId!),
              eq(sources.tenantId, tenantId),
            ))
            .innerJoin(areas, and(
              eq(areas.id, sources.areaId!),
              eq(areas.tenantId, tenantId),
            ))
            .where(and(
              eq(documents.id, candidate.documentId),
              eq(documents.tenantId, tenantId),
              eq(documents.state, "processed"),
              notExists(transaction.select({ id: occurrences.id })
                .from(occurrences)
                .where(and(
                  eq(occurrences.tenantId, tenantId),
                  eq(occurrences.documentId, documents.id),
                  eq(occurrences.status, "approved"),
                ))),
              notExists(transaction.select({ id: auditLog.id })
                .from(auditLog)
                .where(and(
                  eq(auditLog.tenantId, tenantId),
                  eq(auditLog.action, "ingestion.run50_etappe.document"),
                  sql`BINARY ${auditLog.entityId} = BINARY CAST(${documents.id} AS CHAR)`,
                ))),
            ))
            .limit(1);
          if (stillEligible.length === 0) return false;

          const activeJob = await transaction.select({ id: jobs.id })
            .from(jobs)
            .where(and(
              eq(jobs.name, "ingestion.processing.run"),
              eq(jobs.tenantId, tenantId),
              inArray(jobs.status, ["pending", "processing"]),
              sql`JSON_EXTRACT(${jobs.payload}, '$.documentId') = ${candidate.documentId}`,
            ))
            .limit(1);
          if (activeJob.length > 0) return false;

          await transaction.update(documents)
            .set({ state: "uploaded", error: null })
            .where(and(
              eq(documents.id, candidate.documentId),
              eq(documents.tenantId, tenantId),
            ));
          await appendAudit(createDrizzleAuditRepository(transaction), {
            tenantId: String(tenantId),
            action: "ingestion.run50_etappe.document",
            entityType: "ingestion_document",
            entityId: String(candidate.documentId),
            actorId: null,
            actorName: "Run50-Etappe",
            detailsJson: JSON.stringify({ etappe, pages: candidate.pages }),
          });
          await queue.enqueue({
            name: "ingestion.processing.run",
            tenantId: String(tenantId),
            payload: { documentId: candidate.documentId },
            maxAttempts: 1,
          }, transaction);
          return true;
        });
        if (applied) enqueued += 1;
        else skipped += 1;
      }
      console.log(`Eingereiht: ${enqueued}`);
      console.log(`Übersprungen (nicht mehr verfügbar oder aktiver Job): ${skipped}`);
    } else {
      console.log("Probelauf ohne Schreibzugriff.");
    }
  } finally {
    await factory.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
