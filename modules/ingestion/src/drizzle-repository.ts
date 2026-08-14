import type { MySql2Database } from "drizzle-orm/mysql2";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { classifications, documents, occurrences, pages, sources, ingestionSchema } from "./schema.js";
import type { DerivedClassification, DocumentClassification } from "./classification.js";
import type { DocumentListFilters, IngestionOccurrence, IngestionRepository } from "./repository.js";

type IngestionDb = MySql2Database<typeof ingestionSchema>;

export function createDrizzleIngestionRepository(db: unknown): IngestionRepository {
  const database = db as IngestionDb;
  const readClassification = async (tenantId: string, documentId: number) => {
    const row = (await database.select().from(classifications).where(and(
      eq(classifications.tenantId, Number(tenantId)),
      eq(classifications.documentId, documentId),
    )).limit(1))[0];
    if (!row) return null;
    return {
      type: row.type,
      typeSource: row.typeSource as DocumentClassification["typeSource"],
      typeConfidence: row.typeConfidence,
      publicationName: row.publicationName,
      publicationNameSource: row.publicationNameSource as DocumentClassification["publicationNameSource"],
      publicationNameConfidence: row.publicationNameConfidence,
      editionLabel: row.editionLabel,
      editionSource: row.editionSource as DocumentClassification["editionSource"],
      editionConfidence: row.editionConfidence,
      periodStartYear: row.periodStartYear,
      periodEndYear: row.periodEndYear,
      periodIssue: row.periodIssue,
      periodSource: row.periodSource as DocumentClassification["periodSource"],
      periodConfidence: row.periodConfidence,
      regionPlace: row.regionPlace,
      regionDistrict: row.regionDistrict,
      regionState: row.regionState,
      regionSource: row.regionSource as DocumentClassification["regionSource"],
      regionConfidence: row.regionConfidence,
      derivedAt: row.derivedAt,
      correctedAt: row.correctedAt,
      correctedBy: row.correctedBy,
    } satisfies DocumentClassification;
  };
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
    async listDocuments(tenantId, filters: DocumentListFilters = {}) {
      const classificationFilters = [
        filters.type ? eq(classifications.type, filters.type) : undefined,
        filters.regionState ? eq(classifications.regionState, filters.regionState) : undefined,
        filters.regionDistrict ? eq(classifications.regionDistrict, filters.regionDistrict) : undefined,
        filters.periodYear != null
          ? and(
              lte(classifications.periodStartYear, filters.periodYear),
              gte(classifications.periodEndYear, filters.periodYear),
            )
          : undefined,
      ].filter((filter): filter is NonNullable<typeof filter> => filter !== undefined);
      const rows = await database.select({
        document: documents,
        classification: classifications,
      }).from(documents)
        .leftJoin(classifications, and(
          eq(classifications.tenantId, documents.tenantId),
          eq(classifications.documentId, documents.id),
        ))
        .where(and(
          eq(documents.tenantId, Number(tenantId)),
          ...classificationFilters,
        ))
        .orderBy(desc(documents.createdAt));
      const result = rows.map(({ document, classification }) => ({
        ...document,
        tenantId: String(document.tenantId),
        classification: classification
          ? {
              type: classification.type,
              typeSource: classification.typeSource as DocumentClassification["typeSource"],
              typeConfidence: classification.typeConfidence,
              publicationName: classification.publicationName,
              publicationNameSource: classification.publicationNameSource as DocumentClassification["publicationNameSource"],
              publicationNameConfidence: classification.publicationNameConfidence,
              editionLabel: classification.editionLabel,
              editionSource: classification.editionSource as DocumentClassification["editionSource"],
              editionConfidence: classification.editionConfidence,
              periodStartYear: classification.periodStartYear,
              periodEndYear: classification.periodEndYear,
              periodIssue: classification.periodIssue,
              periodSource: classification.periodSource as DocumentClassification["periodSource"],
              periodConfidence: classification.periodConfidence,
              regionPlace: classification.regionPlace,
              regionDistrict: classification.regionDistrict,
              regionState: classification.regionState,
              regionSource: classification.regionSource as DocumentClassification["regionSource"],
              regionConfidence: classification.regionConfidence,
              derivedAt: classification.derivedAt,
              correctedAt: classification.correctedAt,
              correctedBy: classification.correctedBy,
            } satisfies DocumentClassification
          : null,
      }));
      return result as never;
    },
    async upsertDerivedClassification(tenantId, documentId, value) {
      const existing = (await database.select().from(classifications).where(and(
        eq(classifications.tenantId, Number(tenantId)),
        eq(classifications.documentId, documentId),
      )).limit(1))[0];
      const derived = {
        type: value.type,
        typeSource: value.typeSource,
        typeConfidence: value.typeConfidence,
        publicationName: value.publicationName,
        publicationNameSource: value.publicationNameSource,
        publicationNameConfidence: value.publicationNameConfidence,
        editionLabel: value.editionLabel,
        editionSource: value.editionSource,
        editionConfidence: value.editionConfidence,
        periodStartYear: value.periodStartYear,
        periodEndYear: value.periodEndYear,
        periodIssue: value.periodIssue,
        periodSource: value.periodSource,
        periodConfidence: value.periodConfidence,
        regionPlace: value.regionPlace,
        regionDistrict: value.regionDistrict,
        regionState: value.regionState,
        regionSource: value.regionSource,
        regionConfidence: value.regionConfidence,
        derivedAt: new Date(),
      };
      if (!existing) {
        await database.insert(classifications).values({
          tenantId: Number(tenantId),
          documentId,
          ...derived,
          typeSource: value.typeSource,
          publicationNameSource: value.publicationNameSource,
          editionSource: value.editionSource,
          periodSource: value.periodSource,
          regionSource: value.regionSource,
        });
      } else {
        const update: Record<string, unknown> = { derivedAt: derived.derivedAt };
        if (existing.typeSource !== "manual") Object.assign(update, { type: derived.type, typeConfidence: derived.typeConfidence, typeSource: derived.typeSource });
        if (existing.publicationNameSource !== "manual") Object.assign(update, { publicationName: derived.publicationName, publicationNameConfidence: derived.publicationNameConfidence, publicationNameSource: derived.publicationNameSource });
        if (existing.editionSource !== "manual") Object.assign(update, { editionLabel: derived.editionLabel, editionConfidence: derived.editionConfidence, editionSource: derived.editionSource });
        if (existing.periodSource !== "manual") Object.assign(update, {
          periodStartYear: derived.periodStartYear, periodEndYear: derived.periodEndYear,
          periodIssue: derived.periodIssue, periodConfidence: derived.periodConfidence, periodSource: derived.periodSource,
        });
        if (existing.regionSource !== "manual") Object.assign(update, {
          regionPlace: derived.regionPlace, regionDistrict: derived.regionDistrict,
          regionState: derived.regionState, regionConfidence: derived.regionConfidence, regionSource: derived.regionSource,
        });
        await database.update(classifications).set(update).where(eq(classifications.id, existing.id));
      }
      const result = await readClassification(tenantId, documentId);
      if (!result) throw new Error("Dokumenteinordnung konnte nicht gespeichert werden");
      return result;
    },
    async updateClassificationManual(tenantId, documentId, value, actor) {
      const current = await readClassification(tenantId, documentId);
      if (!current) throw new Error("Dokumenteinordnung ist noch nicht vorhanden");
      if (Object.keys(value).length === 0) throw new Error("Keine Änderung vorgenommen.");
      const update: Record<string, unknown> = { correctedAt: new Date(), correctedBy: actor };
      if (value.type !== undefined) Object.assign(update, { type: value.type, typeSource: "manual" });
      if (value.publicationName !== undefined) Object.assign(update, { publicationName: value.publicationName, publicationNameSource: "manual" });
      if (value.editionLabel !== undefined) Object.assign(update, { editionLabel: value.editionLabel, editionSource: "manual" });
      if (value.periodStartYear !== undefined || value.periodEndYear !== undefined || value.periodIssue !== undefined) {
        Object.assign(update, {
          ...(value.periodStartYear !== undefined ? { periodStartYear: value.periodStartYear } : {}),
          ...(value.periodEndYear !== undefined ? { periodEndYear: value.periodEndYear } : {}),
          ...(value.periodIssue !== undefined ? { periodIssue: value.periodIssue } : {}),
          periodSource: "manual",
        });
      }
      if (value.regionPlace !== undefined || value.regionDistrict !== undefined || value.regionState !== undefined) {
        Object.assign(update, {
          ...(value.regionPlace !== undefined ? { regionPlace: value.regionPlace } : {}),
          ...(value.regionDistrict !== undefined ? { regionDistrict: value.regionDistrict } : {}),
          ...(value.regionState !== undefined ? { regionState: value.regionState } : {}),
          regionSource: "manual",
        });
      }
      await database.update(classifications).set(update).where(and(
        eq(classifications.tenantId, Number(tenantId)),
        eq(classifications.documentId, documentId),
      ));
      const result = await readClassification(tenantId, documentId);
      if (!result) throw new Error("Dokumenteinordnung konnte nicht geändert werden");
      return result;
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
