import { readFile } from "node:fs/promises";
import {
  and,
  asc,
  desc,
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
import { actualityMaxAgeYears } from "../modules/ingestion/src/actuality.ts";
import {
  areas,
  classifications,
  documents,
  occurrences,
  pages,
  sources,
} from "../modules/ingestion/src/schema.ts";
import {
  deriveRun50EtappeAreaFromContacts,
  parseRun50EtappeArguments,
  parseRun50EtappeDocumentList,
  parseRun50EtappeExclusionList,
  run50EtappeTargetPages,
  isRun50EtappeYearEligible,
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
  const { tenantId, etappe, anteil, apply, maxPages, exclusionFile, documentFile } =
    parseRun50EtappeArguments(process.argv.slice(2));
  const excludedDocumentIds = exclusionFile
    ? parseRun50EtappeExclusionList(await readFile(exclusionFile, "utf8"))
    : new Set<number>();
  const documentIds = documentFile
    ? parseRun50EtappeDocumentList(await readFile(documentFile, "utf8"))
    : undefined;
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
    const targetPages = anteil === undefined
      ? undefined
      : run50EtappeTargetPages(totalProcessedPages, anteil);
    const listedDocumentRows = documentIds === undefined || documentIds.length === 0
      ? []
      : await db.select({
          documentId: documents.id,
          state: documents.state,
          pages: sql<number>`COUNT(${pages.id})`,
        })
          .from(documents)
          .leftJoin(pages, eq(pages.documentId, documents.id))
          .where(and(
            eq(documents.tenantId, tenantId),
            inArray(documents.id, documentIds),
          ))
          .groupBy(documents.id, documents.state);
    const listedDocumentById = new Map(
      listedDocumentRows.map((row) => [row.documentId, row]),
    );
    const approvedDocumentIds = documentIds === undefined || documentIds.length === 0
      ? new Set<number>()
      : new Set((await db.select({ documentId: occurrences.documentId })
          .from(occurrences)
          .where(and(
            eq(occurrences.tenantId, tenantId),
            inArray(occurrences.documentId, documentIds),
            eq(occurrences.status, "approved"),
          )))
        .map((row) => row.documentId));
    const run50AuditRows = documentIds === undefined || documentIds.length === 0
      ? []
      : await db.select({
          documentId: auditLog.entityId,
          detailsJson: auditLog.detailsJson,
        })
          .from(auditLog)
          .where(and(
            eq(auditLog.tenantId, tenantId),
            eq(auditLog.action, "ingestion.run50_etappe.document"),
            inArray(auditLog.entityId, documentIds.map(String)),
          ))
          .orderBy(desc(auditLog.id));
    const stagedDocumentById = new Map<number, string>();
    for (const row of run50AuditRows) {
      const documentId = Number(row.documentId);
      if (!Number.isSafeInteger(documentId) || stagedDocumentById.has(documentId)) continue;
      let etappeName = "unbekannt";
      try {
        const details = JSON.parse(row.detailsJson ?? "") as { etappe?: unknown };
        if (typeof details.etappe === "string" && details.etappe.trim()) {
          etappeName = details.etappe;
        }
      } catch {
        etappeName = "unbekannt";
      }
      stagedDocumentById.set(documentId, etappeName);
    }
    const rows = await db.select({
      documentId: documents.id,
      sha256: documents.sha256,
      filename: documents.filename,
      ags: areas.ags,
      areaName: areas.name,
      periodEndYear: classifications.periodEndYear,
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
      .leftJoin(classifications, and(
        eq(classifications.documentId, documents.id),
        eq(classifications.tenantId, tenantId),
      ))
      .leftJoin(pages, eq(pages.documentId, documents.id))
      .where(and(
        eq(documents.tenantId, tenantId),
        eq(documents.state, "processed"),
        ...(documentIds === undefined
          ? []
          : [documentIds.length > 0
            ? inArray(documents.id, documentIds)
            : sql`1 = 0`]),
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
        classifications.periodEndYear,
      )
      .orderBy(asc(documents.sha256), asc(documents.id));
    const candidates = rows.map((row) => ({
      documentId: row.documentId,
      sha256: row.sha256,
      filename: row.filename,
      ags: row.ags,
      areaName: row.areaName,
      periodEndYear: row.periodEndYear,
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
    const currentYear = new Date().getFullYear();
    const maxAgeYears = actualityMaxAgeYears();
    const excludedByYearCount = candidatesWithArea.filter((candidate) =>
      !isRun50EtappeYearEligible(candidate.periodEndYear, currentYear, maxAgeYears)
    ).length;
    const candidatesById = new Map(
      candidatesWithArea.map((candidate) => [candidate.documentId, candidate]),
    );
    const selected = documentIds === undefined
      ? selectRun50EtappeDocuments(
        candidatesWithArea,
          targetPages ?? 0,
          etappe,
          maxPages,
          currentYear,
          maxAgeYears,
        )
      : documentIds.flatMap((documentId) => {
        const candidate = candidatesById.get(documentId);
        return candidate
          && isRun50EtappeYearEligible(candidate.periodEndYear, currentYear, maxAgeYears)
          && (maxPages === undefined || candidate.pages <= maxPages)
          ? [candidate]
          : [];
      });
    const selectedDocumentIds = new Set(selected.map((candidate) => candidate.documentId));
    const unselectedDocumentIds = documentIds?.filter((documentId) =>
      !selectedDocumentIds.has(documentId)
    ) ?? [];
    const reasonForUnselectedDocument = (documentId: number): string => {
      const document = listedDocumentById.get(documentId);
      if (!document) return "unbekannt";
      const stagedEtappe = stagedDocumentById.get(documentId);
      if (stagedEtappe !== undefined) return `bereits in Etappe ${stagedEtappe}`;
      if (document.state !== "processed") return "nicht processed";
      if (approvedDocumentIds.has(documentId)) return "bereits freigegebene Anzeige";
      if (excludedDocumentIds.has(documentId)) return "Ausschlussliste";
      const candidate = candidatesById.get(documentId);
      if (candidate && !isRun50EtappeYearEligible(candidate.periodEndYear, currentYear, maxAgeYears)) {
        return "Jahr außerhalb des Aktualitätszeitraums";
      }
      if (maxPages !== undefined && Number(document.pages) > maxPages) return "zu groß";
      return "unbekannt";
    };
    const selectedPages = selected.reduce((sum, item) => sum + item.pages, 0);
    const distinctAreaCount = new Set(selected
      .filter((candidate) => candidate.areaOrigin !== "offen")
      .map((candidate) => candidate.areaLabel)).size;
    const fromAdsCount = selected.filter((candidate) => candidate.areaOrigin === "anzeigen").length;
    const openAreaCount = selected.filter((candidate) => candidate.areaOrigin === "offen").length;

    console.log(`Etappe: ${etappe}`);
    console.log(`Anteil: ${anteil === undefined ? "Dokumentenliste" : `${anteil}%`}`);
    console.log(`Zielseiten: ${targetPages ?? "—"}`);
    console.log(`Max. Seiten je Heft: ${maxPages ?? "—"}`);
    console.log(`Ausgeschlossen (Liste): ${excludedFromStock.length}`);
    console.log(`Ausgeschlossen (Jahr): ${excludedByYearCount}`);
    console.log(`Ausgeschlossen (zu groß): ${oversizedCandidateCount}`);
    console.log(`Dokumente: ${selected.length}`);
    console.log(`Seiten: ${selectedPages}`);
    console.log(`Gebiete: ${distinctAreaCount}`);
    console.log(
      `Davon ohne Quellgebiet: ${fromAdsCount + openAreaCount} (aus Anzeigen: ${fromAdsCount}, offen: ${openAreaCount})`,
    );
    console.log(`Geschätzte Kosten: ${(selectedPages * 0.021).toFixed(2)} USD`);
    if (documentIds !== undefined) {
      console.log("Nicht ausgewählt:");
      if (unselectedDocumentIds.length === 0) {
        console.log("Keine");
      } else {
        console.log(["document_id", "Grund"].join("\t"));
        for (const documentId of unselectedDocumentIds) {
          console.log(`${documentId}\t${reasonForUnselectedDocument(documentId)}`);
        }
      }
    }
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
