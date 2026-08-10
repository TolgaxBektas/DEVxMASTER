import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { EventEnvelope } from "@xmaster-center/contracts";
import { eventOutbox } from "./db/schema.js";
import type { EventRepository } from "./events.js";

export function isDuplicateKeyError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      code?: unknown;
      errno?: unknown;
      cause?: unknown;
    };
    if (
      candidate.errno === 1062
      || candidate.code === 1062
      || candidate.code === "ER_DUP_ENTRY"
      || candidate.code === "ER_DUP_KEY"
    ) return true;
    current = candidate.cause;
  }
  return /duplicate|unique|ER_DUP_ENTRY/i.test(String(error));
}

export function createDrizzleEventRepository(db: any): EventRepository {
  return {
    async append(event) {
      const existing = (
        await db
          .select()
          .from(eventOutbox)
          .where(eq(eventOutbox.idempotencyKey, event.idempotencyKey))
          .limit(1)
      )[0];
      if (existing) return rowToEvent(existing);
      try {
        await db.insert(eventOutbox).values({
          eventId: event.id,
          tenantId: Number(event.tenantId),
          name: event.name,
          aggregateType: event.aggregateType,
          aggregateId: String(event.aggregateId),
          payload: event.payload,
          idempotencyKey: event.idempotencyKey,
          attempts: 0,
          deliveryAttempts: 0,
          nextAttemptAt: null,
          deadLetter: false,
          successfulHandlers: [],
          publishedAt: null,
        });
        return event;
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const row = (
          await db
            .select()
            .from(eventOutbox)
            .where(eq(eventOutbox.idempotencyKey, event.idempotencyKey))
            .limit(1)
        )[0];
        if (!row) throw error;
        return rowToEvent(row);
      }
    },
    async pending(limit, now = new Date()) {
      const rows = await db
        .select()
        .from(eventOutbox)
        .where(
          and(
            isNull(eventOutbox.publishedAt),
            eq(eventOutbox.deadLetter, false),
            or(
              isNull(eventOutbox.nextAttemptAt),
              lte(eventOutbox.nextAttemptAt, now),
            ),
          ),
        )
        .orderBy(asc(eventOutbox.createdAt))
        .limit(limit);
      return rows.map(rowToEvent);
    },
    async state(eventId) {
      const row = (
        await db
          .select()
          .from(eventOutbox)
          .where(eq(eventOutbox.eventId, eventId))
          .limit(1)
      )[0];
      if (!row) throw new Error(`Event nicht gefunden: ${eventId}`);
      return {
        attempts: Number(row.deliveryAttempts ?? 0),
        nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt) : null,
        deadLetter: Boolean(row.deadLetter),
        successfulHandlers: row.successfulHandlers ?? [],
      };
    },
    async recordHandlerSuccess(eventId, handlerKey) {
      const row = (
        await db
          .select({ handlers: eventOutbox.successfulHandlers })
          .from(eventOutbox)
          .where(eq(eventOutbox.eventId, eventId))
          .limit(1)
      )[0];
      const handlers = [...(row?.handlers ?? [])];
      if (!handlers.includes(handlerKey)) handlers.push(handlerKey);
      await db
        .update(eventOutbox)
        .set({ successfulHandlers: handlers })
        .where(eq(eventOutbox.eventId, eventId));
    },
    async recordHandlerFailure(eventId, input) {
      await db
        .update(eventOutbox)
        .set({
          deliveryAttempts: sql`${eventOutbox.deliveryAttempts} + 1`,
          nextAttemptAt: input.nextAttemptAt,
          deadLetter: input.deadLetter,
        })
        .where(eq(eventOutbox.eventId, eventId));
    },
    async requeue(eventId) {
      const current = (
        await db
          .select()
          .from(eventOutbox)
          .where(eq(eventOutbox.eventId, eventId))
          .limit(1)
      )[0];
      if (!current) return null;
      if (current.publishedAt || !current.deadLetter) {
        throw new Error("Nur Dead Letters können erneut zugestellt werden");
      }
      await db
        .update(eventOutbox)
        .set({
          deliveryAttempts: 0,
          nextAttemptAt: null,
          deadLetter: false,
          publishedAt: null,
        })
        .where(
          and(
            eq(eventOutbox.eventId, eventId),
            eq(eventOutbox.deadLetter, true),
            isNull(eventOutbox.publishedAt),
          ),
        );
      const row = (
        await db
          .select()
          .from(eventOutbox)
          .where(eq(eventOutbox.eventId, eventId))
          .limit(1)
      )[0];
      if (!row || row.publishedAt || row.deadLetter) {
        throw new Error("Ereignis konnte nicht erneut zugestellt werden");
      }
      return rowToEvent(row);
    },
    async markPublished(id) {
      await db
        .update(eventOutbox)
        .set({ publishedAt: new Date() })
        .where(eq(eventOutbox.eventId, id));
    },
  };
}

function rowToEvent(row: any): EventEnvelope {
  return {
    id: String(row.eventId),
    name: String(row.name),
    tenantId: String(row.tenantId),
    occurredAt: new Date(row.createdAt),
    aggregateType: String(row.aggregateType),
    aggregateId: String(row.aggregateId),
    payload: row.payload,
    idempotencyKey: String(row.idempotencyKey),
  };
}
