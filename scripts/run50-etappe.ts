import { readFile } from "node:fs/promises";
import {
  and,
  asc,
  eq,
  inArray,
  notExists,
  notInArray,
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
  deriveRun50EtappeAreaFromContacts,
  parseRun50EtappeArguments,
  parseRun50EtappeExclusionList,
  run50EtappeTargetPages,
  selectRun50EtappeDocuments,
  type Run50EtappeContact,
} from "../modules/ingestion/src/run50-etappe.ts";

function parseOccurrenceContacts(value: unknown): Run50EtappeContact | null {
  let contacts = value;
  if (typeof contacts === "string") {
    try {
      contacts = JSON.parse(contacts);
    } catch {
      return null;
    }
  }
  if (typeof contacts !== "object" || contacts === null || Array.isArray(contacts)) {
    return null;
  }
  const record = contacts as Record<string, unknown>;
  return {
    city: typeof record.city === "string" ? record.city : null,
    postalCode: typeof record.postalCode === "string" ? record.postalCode : null,
  };
}

async function main() {
  const { tenantId, etappe, anteil, apply, maxPages, exclusionFile } =
    parseRun50EtappeArguments(process.argv.slice(2));
  const excludedDocumentIds = exclusionFile
    ? parseRun50EtappeExclusionList(await readFile(exclusionFile, "utf8"))
    : new Set<number>();
  const factory = createDbFactory(parseEnv());

  try {
    const db = factory.get();
    const processedStockRows = await db.select({
      documentId: documents.id,
      pages: sql<number>`COUNT(${pages.id})`,
    })
      .from(documents)
      .leftJoin(pages, eq(pages.documentId, documents.id))
      .where(and(
        eq(documents.tenantId, tenantId),
        eq(documents.state, "processed"),
      ))
      .groupBy(documents.id);
    const excludedFromStock = processedStockRows.filter((row) =>
      excludedDocumentIds.has(row.documentId)
    );
    const totalProcessedPages = processedStockRows.reduce(
      (total, row) => total + (excludedDocumentIds.has(row.documentId) ? 0 : Number(row.pages)),
      0,
    );
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
      .leftJoin(sources, and(
        eq(sources.id, documents.sourceId!),
        eq(sources.tenantId, tenantId),
      ))
      .leftJoin(areas, and(
        eq(areas.id, sources.areaId!),
        eq(areas.tenantId, tenantId),
      ))
      .leftJoin(pages, eq(pages.documentId, documents.id))
      .where(and(
        eq(documents.tenantId, tenantId),
        eq(documents.state, "processed"),
        ...(excludedDocumentIds.size > 0
          ? [notInArray(documents.id, [...excludedDocumentIds])]
          : []),
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
      .orderBy(asc(documents.sha256), asc(documents.id));
    const candidates = rows.map((row) => ({
      documentId: row.documentId,
      sha256: row.sha256,
      filename: row.filename,
      ags: row.ags,
      areaName: row.areaName,
      pages: Number(row.pages),
    }));
    const areaLessDocumentIds = candidates
      .filter((candidate) => candidate.ags === null || candidate.areaName === null)
      .map((candidate) => candidate.documentId);
    const contactRows = areaLessDocumentIds.length === 0
      ? []
      : await db.select({
          documentId: occurrences.documentId,
          contacts: occurrences.contacts,
        })
          .from(occurrences)
          .where(and(
            eq(occurrences.tenantId, tenantId),
            inArray(occurrences.documentId, areaLessDocumentIds),
          ));
    const contactsByDocument = new Map<number, Run50EtappeContact[]>();
    for (const row of contactRows) {
      const contacts = parseOccurrenceContacts(row.contacts);
      if (!contacts) continue;
      const documentContacts = contactsByDocument.get(row.documentId) ?? [];
      documentContacts.push(contacts);
      contactsByDocument.set(row.documentId, documentContacts);
    }
    const candidatesWithArea = candidates.map((candidate) => {
      if (candidate.ags !== null && candidate.areaName !== null) {
        return {
          ...candidate,
          areaLabel: `${candidate.ags} ${candidate.areaName}`,
          areaOrigin: "quelle" as const,
        };
      }
      const derivedArea = deriveRun50EtappeAreaFromContacts(
        contactsByDocument.get(candidate.documentId) ?? [],
      );
      if (!derivedArea) {
        return {
          ...candidate,
          areaLabel: "wird aus den Anzeigen ermittelt",
          areaOrigin: "offen" as const,
        };
      }
      const postalCode = derivedArea.postalCode ? ` (${derivedArea.postalCode})` : "";
      return {
        ...candidate,
        areaLabel: `${derivedArea.city}${postalCode}, ${derivedArea.votes} von ${derivedArea.total} Anzeigen`,
        areaOrigin: "anzeigen" as const,
      };
    });
    const oversizedCandidateCount = maxPages === undefined
      ? 0
      : candidatesWithArea.filter((candidate) => candidate.pages > maxPages).length;
    const selected = selectRun50EtappeDocuments(
      candidatesWithArea,
      targetPages,
      etappe,
      maxPages,
    );
    const selectedPages = selected.reduce((sum, item) => sum + item.pages, 0);
    const distinctAreaCount = new Set(selected
      .filter((candidate) => candidate.areaOrigin !== "offen")
      .map((candidate) => candidate.areaLabel)).size;
    const fromAdsCount = selected.filter((candidate) => candidate.areaOrigin === "anzeigen").length;
    const openAreaCount = selected.filter((candidate) => candidate.areaOrigin === "offen").length;

    console.log(`Etappe: ${etappe}`);
    console.log(`Anteil: ${anteil}%`);
    console.log(`Zielseiten: ${targetPages}`);
    console.log(`Max. Seiten je Heft: ${maxPages ?? "—"}`);
    console.log(`Ausgeschlossen (Liste): ${excludedFromStock.length}`);
    console.log(`Ausgeschlossen (zu groß): ${oversizedCandidateCount}`);
    console.log(`Dokumente: ${selected.length}`);
    console.log(`Seiten: ${selectedPages}`);
    console.log(`Gebiete: ${distinctAreaCount}`);
    console.log(
      `Davon ohne Quellgebiet: ${fromAdsCount + openAreaCount} (aus Anzeigen: ${fromAdsCount}, offen: ${openAreaCount})`,
    );
    console.log(`Geschätzte Kosten: ${(selectedPages * 0.021).toFixed(2)} USD`);
    console.log(["document_id", "gebiet", "gebiet_herkunft", "pages", "filename"].join("\t"));
    for (const candidate of selected) {
      console.log([
        candidate.documentId,
        candidate.areaLabel,
        candidate.areaOrigin,
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
