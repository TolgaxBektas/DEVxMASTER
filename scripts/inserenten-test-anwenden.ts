import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  appendAudit,
  createDbFactory,
  createDrizzleAuditRepository,
  parseEnv,
} from "../packages/kernel/src/index.ts";
import { occurrences } from "../modules/ingestion/src/schema.ts";
import {
  collapseVerdicts,
  mergeEvidence,
  parseVerdictFile,
  plannedRejection,
  rejectionEvidence,
  updatedRowCount,
} from "../modules/ingestion/src/inserenten-test-verdicts.ts";

type Summary = {
  changed: number;
  protected: number;
  unknown: number;
};

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function parseTenant(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const tenantId = Number(value);
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error("Die Mandantenkennung muss eine positive Ganzzahl sein.");
  }
  return tenantId;
}

function summaryFor(summaries: Map<string, Summary>, tenantId: string): Summary {
  const existing = summaries.get(tenantId);
  if (existing) return existing;
  const summary = { changed: 0, protected: 0, unknown: 0 };
  summaries.set(tenantId, summary);
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const verdictPath = argumentValue(args, "--urteile");
  if (!verdictPath) throw new Error("Pflichtargument --urteile <pfad> fehlt.");
  const tenantId = parseTenant(argumentValue(args, "--mandant"));
  const apply = args.includes("--anwenden");
  const content = await readFile(resolve(verdictPath), "utf8");
  const verdicts = collapseVerdicts(parseVerdictFile(content));
  const factory = createDbFactory(parseEnv());
  try {
    const db = factory.get();
    const summaries = new Map<string, Summary>();
    let ignoredCompanies = 0;
    let totalChanged = 0;
    let totalProtected = 0;
    let totalUnknown = 0;

    for (const verdict of verdicts) {
      if (verdict.verdict !== "keine_anzeige") {
        ignoredCompanies += 1;
        continue;
      }
      const row = (await db.select().from(occurrences).where(and(
        eq(occurrences.id, verdict.occurrenceId),
        tenantId === undefined ? undefined : eq(occurrences.tenantId, tenantId),
      )).limit(1))[0];
      if (!row) {
        const summary = summaryFor(summaries, tenantId === undefined ? "unbekannt" : String(tenantId));
        summary.unknown += 1;
        totalUnknown += 1;
        continue;
      }
      const summary = summaryFor(summaries, String(row.tenantId));
      if (!plannedRejection(row, verdict.verdict)) {
        summary.protected += 1;
        totalProtected += 1;
        continue;
      }
      const reasons = rejectionEvidence(verdict.reason);
      const evidence = Array.isArray(row.evidence) ? row.evidence as string[] : null;
      if (apply) {
        const changed = await db.transaction(async (transaction) => {
          const result = await transaction.update(occurrences)
            .set({
              status: "rejected",
              evidence: mergeEvidence(evidence, reasons),
            })
            .where(and(
              eq(occurrences.id, verdict.occurrenceId),
              eq(occurrences.tenantId, row.tenantId),
              eq(occurrences.status, "detected"),
            ));
          if (updatedRowCount(result) === 0) return false;
          const transactionAudit = createDrizzleAuditRepository({
            select: transaction.select.bind(transaction),
            insert: transaction.insert.bind(transaction),
            update: transaction.update.bind(transaction),
          });
          await appendAudit(transactionAudit, {
            tenantId: String(row.tenantId),
            action: "ingestion.occurrence.rejected",
            entityType: "ingestion_occurrence",
            entityId: row.id,
            actorId: null,
            actorName: "Inserenten-Test (System)",
            detailsJson: JSON.stringify({
              status: "rejected",
              reasons,
              verdictSource: "inserenten-test",
              verdictFile: basename(verdictPath),
            }),
          });
          return true;
        });
        if (!changed) {
          summary.protected += 1;
          totalProtected += 1;
          continue;
        }
      }
      summary.changed += 1;
      totalChanged += 1;
    }

    console.log(apply ? "Urteile wurden angewendet." : "Probelauf ohne Schreibzugriff.");
    for (const [summaryTenantId, summary] of summaries) {
      console.log(`Mandant ${summaryTenantId}: geändert ${summary.changed}, geschützt ${summary.protected}, unbekannt ${summary.unknown}`);
    }
    console.log(`Gesamt: geändert ${totalChanged}, geschützt ${totalProtected}, unbekannt ${totalUnknown}, Firmenanzeigen ignoriert ${ignoredCompanies}`);
  } finally {
    await factory.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
