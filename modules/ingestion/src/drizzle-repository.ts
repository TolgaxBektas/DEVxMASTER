import type { MySql2Database } from "drizzle-orm/mysql2";
import { and, desc, eq } from "drizzle-orm";
import { documents, occurrences, pages, sources, ingestionSchema } from "./schema.js";
import type { IngestionRepository } from "./repository.js";

type IngestionDb = MySql2Database<typeof ingestionSchema>;

export function createDrizzleIngestionRepository(db: unknown): IngestionRepository {
  const database = db as IngestionDb;
  return {
    async listSources(tenantId) {
      return database.select().from(sources)
        .where(eq(sources.tenantId, Number(tenantId)))
        .orderBy(desc(sources.createdAt)) as never;
    },
    async listDocuments(tenantId) {
      return database.select().from(documents)
        .where(eq(documents.tenantId, Number(tenantId)))
        .orderBy(desc(documents.createdAt)) as never;
    },
    async listOccurrences(tenantId) {
      return database.select().from(occurrences)
        .where(eq(occurrences.tenantId, Number(tenantId)))
        .orderBy(desc(occurrences.createdAt)) as never;
    },
    async ingestDemo(tenantId) {
      const sourceRow = await database.insert(sources).values({
        tenantId: Number(tenantId),
        url: `${tenantId}:demo://publication`,
        status: "discovered",
      });
      const sourceId = Number(sourceRow[0]?.insertId);
      const hash = `demo-${tenantId}-1`;
      const existing = await database.select().from(documents).where(
        and(eq(documents.tenantId, Number(tenantId)), eq(documents.sha256, hash)),
      ).limit(1);
      let documentId = existing[0]?.id;
      if (!documentId) {
        try {
          const documentRow = await database.insert(documents).values({
            tenantId: Number(tenantId),
            sourceId,
            filename: "demo-publication.pdf",
            sha256: hash,
            state: "discovered",
          });
          documentId = Number(documentRow[0]?.insertId);
        } catch {
          const concurrent = await database.select().from(documents).where(
            and(eq(documents.tenantId, Number(tenantId)), eq(documents.sha256, hash)),
          ).limit(1);
          documentId = concurrent[0]?.id;
        }
      }
      const priorOccurrence = documentId
        ? (await database.select().from(occurrences).where(eq(occurrences.documentId, documentId)).limit(1))[0]
        : undefined;
      if (!documentId) throw new Error("Dokument konnte nicht angelegt werden");
      if (documentId && !priorOccurrence) {
        await database.update(documents).set({ state: "processing" }).where(eq(documents.id, documentId));
        await database.update(documents).set({ state: "processed" }).where(eq(documents.id, documentId));
        const pageRow = await database.insert(pages).values({
          documentId,
          pageNumber: 1,
          text: "Beispiel GmbH · Werbung · 01234 567890",
        });
        await database.insert(occurrences).values({
          tenantId: Number(tenantId),
          documentId,
          pageId: Number(pageRow[0]?.insertId),
          company: "Beispiel GmbH",
          preview: "Beispiel GmbH · Werbung · 01234 567890",
          status: "detected",
        });
      }
      const source = (await database.select().from(sources).where(eq(sources.id, sourceId)).limit(1))[0];
      const document = (await database.select().from(documents).where(eq(documents.id, documentId)).limit(1))[0];
      const occurrence = (await database.select().from(occurrences).where(eq(occurrences.documentId, documentId)).limit(1))[0];
      if (!source || !document || !occurrence) throw new Error("Ingestion-Ergebnis fehlt");
      return { source, document, occurrence };
    },
    async setDocumentState(tenantId, documentId, state, error = null) {
      const current = (await database.select().from(documents).where(
        and(eq(documents.id, documentId), eq(documents.tenantId, Number(tenantId))),
      ).limit(1))[0];
      if (!current) throw new Error("Dokument nicht gefunden");
      const allowed: Record<string, string[]> = {
        discovered: ["processing", "failed"],
        processing: ["processed", "failed"],
        failed: ["processing"],
        processed: [],
      };
      if (!allowed[current.state]?.includes(state))
        throw new Error(`Ungültiger Dokumentzustand: ${current.state} -> ${state}`);
      await database.update(documents).set({ state, error }).where(
        and(eq(documents.id, documentId), eq(documents.tenantId, Number(tenantId))),
      );
      const row = (await database.select().from(documents).where(
        and(eq(documents.id, documentId), eq(documents.tenantId, Number(tenantId))),
      ).limit(1))[0];
      if (!row) throw new Error("Dokument nicht gefunden");
      return row;
    },
  };
}
