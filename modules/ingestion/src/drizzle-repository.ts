import type { MySql2Database } from "drizzle-orm/mysql2";
import { and, desc, eq } from "drizzle-orm";
import { documents, occurrences, pages, sources, ingestionSchema } from "./schema.js";
import type { IngestionOccurrence, IngestionRepository } from "./repository.js";

type IngestionDb = MySql2Database<typeof ingestionSchema>;

export function createDrizzleIngestionRepository(db: unknown): IngestionRepository {
  const database = db as IngestionDb;
  return {
    async listSources(tenantId) {
      return database.select().from(sources)
        .where(eq(sources.tenantId, Number(tenantId)))
        .orderBy(desc(sources.createdAt)) as never;
    },
    async createSource(tenantId, input) {
      const existing = await database.select().from(sources).where(and(
        eq(sources.tenantId, Number(tenantId)),
        eq(sources.url, input.url),
      )).limit(1);
      if (existing[0]) return existing[0] as never;
      const result = await database.insert(sources).values({
        tenantId: Number(tenantId),
        url: input.url,
        status: "proposed",
        score: input.score,
        metadata: input.metadata,
      });
      const created = (await database.select().from(sources)
        .where(eq(sources.id, Number(result[0]?.insertId))).limit(1))[0];
      if (!created) throw new Error("Quelle konnte nicht angelegt werden");
      return created as never;
    },
    async getSource(tenantId, sourceId) {
      const source = (await database.select().from(sources).where(and(
        eq(sources.id, sourceId),
        eq(sources.tenantId, Number(tenantId)),
      )).limit(1))[0];
      if (!source) throw new Error("Quelle nicht gefunden");
      return source as never;
    },
    async updateSource(tenantId, sourceId, input) {
      await database.update(sources).set(input).where(and(
        eq(sources.id, sourceId),
        eq(sources.tenantId, Number(tenantId)),
      ));
      return this.getSource(tenantId, sourceId);
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
    async createUploadedDocument(tenantId, input) {
      const existing = await database.select().from(documents).where(
        and(eq(documents.tenantId, Number(tenantId)), eq(documents.sha256, input.sha256)),
      ).limit(1);
      if (existing[0]) return { document: existing[0] as never, deduplicated: true };
      try {
        const documentRow = await database.insert(documents).values({
          tenantId: Number(tenantId),
          sourceId: input.sourceId ?? null,
          filename: input.filename,
          sha256: input.sha256,
          storageKey: input.storageKey,
          sizeBytes: input.sizeBytes,
          mimeType: input.mimeType,
          origin: input.origin,
          state: "uploaded",
        });
        const documentId = Number(documentRow[0]?.insertId);
        const document = (await database.select().from(documents)
          .where(eq(documents.id, documentId)).limit(1))[0];
        if (!document) throw new Error("Dokument konnte nicht angelegt werden");
        return { document: document as never, deduplicated: false };
      } catch (error) {
        if (!/duplicate|unique|ER_DUP_ENTRY/i.test(String(error))) throw error;
        const concurrent = await database.select().from(documents).where(
          and(eq(documents.tenantId, Number(tenantId)), eq(documents.sha256, input.sha256)),
        ).limit(1);
        if (!concurrent[0]) throw error;
        return { document: concurrent[0] as never, deduplicated: true };
      }
    },
    async getDocument(tenantId, documentId) {
      const document = (await database.select().from(documents).where(
        and(eq(documents.id, documentId), eq(documents.tenantId, Number(tenantId))),
      ).limit(1))[0];
      if (!document) throw new Error("Dokument nicht gefunden");
      return document as never;
    },
    async getDocumentById(documentId) {
      const document = (await database.select().from(documents)
        .where(eq(documents.id, documentId)).limit(1))[0];
      if (!document) throw new Error("Dokument nicht gefunden");
      return document as never;
    },
    async replaceProcessedDocument(tenantId, documentId, processedPages) {
      const document = await this.getDocument(tenantId, documentId);
      await database.delete(occurrences).where(eq(occurrences.documentId, documentId));
      await database.delete(pages).where(eq(pages.documentId, documentId));
      const created: IngestionOccurrence[] = [];
      for (const processed of processedPages) {
        const pageRow = await database.insert(pages).values({
          documentId,
          pageNumber: processed.pageNumber,
          text: processed.text,
          imageKey: processed.imageKey,
          classification: processed.classification,
          adProbability: processed.adProbability,
        });
        const pageId = Number(pageRow[0]?.insertId);
        for (const occurrence of processed.occurrences) {
          const occurrenceRow = await database.insert(occurrences).values({
            tenantId: Number(tenantId),
            documentId,
            pageId,
            company: occurrence.company,
            preview: occurrence.preview,
            status: "detected",
            bbox: occurrence.bbox,
            imageKey: occurrence.imageKey,
            confidence: occurrence.confidence,
          });
          created.push({
            id: Number(occurrenceRow[0]?.insertId),
            documentId,
            pageNumber: processed.pageNumber,
            company: occurrence.company,
            preview: occurrence.preview,
            status: "detected",
            bbox: occurrence.bbox,
            imageKey: occurrence.imageKey,
            confidence: occurrence.confidence,
          });
        }
      }
      await database.update(documents).set({ state: "processed", error: null })
        .where(and(eq(documents.id, document.id), eq(documents.tenantId, Number(tenantId))));
      return created;
    },
    async setDocumentState(tenantId, documentId, state, error = null) {
      const current = (await database.select().from(documents).where(
        and(eq(documents.id, documentId), eq(documents.tenantId, Number(tenantId))),
      ).limit(1))[0];
      if (!current) throw new Error("Dokument nicht gefunden");
      const allowed: Record<string, string[]> = {
        uploaded: ["processing", "failed"],
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
      return { ...row, tenantId: String(row.tenantId) } as never;
    },
  };
}
