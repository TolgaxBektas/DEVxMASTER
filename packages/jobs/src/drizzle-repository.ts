import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { jobs } from "@xmaster-center/kernel";
import type { ClaimedJob, JobRecord, QueueRepository } from "./types.js";

type DbLike = any;

export class DrizzleQueueRepository implements QueueRepository {
  constructor(private readonly db: DbLike) {}
  async insert(job: JobRecord) {
    await this.db.insert(jobs).values(job);
  }
  async claim(
    now: Date,
    leaseMs: number,
    _workerId: string,
  ): Promise<ClaimedJob | null> {
    const candidate = (
      await this.db
        .select()
        .from(jobs)
        .where(
          and(
            or(
              and(eq(jobs.status, "pending"), lte(jobs.availableAt, now)),
              and(eq(jobs.status, "processing"), lte(jobs.leaseExpiresAt, now)),
            ),
          ),
        )
        .orderBy(asc(jobs.availableAt))
        .limit(1)
    )[0];
    if (!candidate) return null;
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    await this.db
      .update(jobs)
      .set({
        status: "processing",
        leaseToken,
        leaseExpiresAt,
        attempts: sql`${jobs.attempts} + 1`,
        updatedAt: now,
        lastError: null,
      })
      .where(
        and(
          eq(jobs.id, candidate.id),
          or(
            and(eq(jobs.status, "pending"), lte(jobs.availableAt, now)),
            and(eq(jobs.status, "processing"), lte(jobs.leaseExpiresAt, now)),
          ),
        ),
      );
    const row = (
      await this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, candidate.id), eq(jobs.leaseToken, leaseToken)))
        .limit(1)
    )[0];
    return row ? { ...row, leaseToken, leaseExpiresAt } : null;
  }
  async heartbeat(id: string, leaseToken: string, leaseMs: number, now: Date) {
    const result = await this.db
      .update(jobs)
      .set({
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      })
      .where(
        and(
          eq(jobs.id, id),
          eq(jobs.leaseToken, leaseToken),
          eq(jobs.status, "processing"),
        ),
      );
    return Number(result[0]?.affectedRows ?? result.affectedRows ?? 0) > 0;
  }
  async complete(id: string, leaseToken: string, now: Date) {
    const result = await this.db
      .update(jobs)
      .set({
        status: "completed",
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(jobs.id, id),
          eq(jobs.leaseToken, leaseToken),
          eq(jobs.status, "processing"),
        ),
      );
    return Number(result[0]?.affectedRows ?? result.affectedRows ?? 0) > 0;
  }
  async fail(input: {
    id: string;
    leaseToken: string;
    error: string;
    now: Date;
    nextAttemptAt: Date | null;
    dead: boolean;
  }) {
    const result = await this.db
      .update(jobs)
      .set({
        status: input.dead ? "dead" : "pending",
        leaseToken: null,
        leaseExpiresAt: null,
        availableAt: input.nextAttemptAt ?? input.now,
        lastError: input.error,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(jobs.id, input.id),
          eq(jobs.leaseToken, input.leaseToken),
          eq(jobs.status, "processing"),
        ),
      );
    return Number(result[0]?.affectedRows ?? result.affectedRows ?? 0) > 0;
  }
  async get(id: string) {
    return (
      (await this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1))[0] ??
      null
    );
  }
}
