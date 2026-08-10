import { randomUUID } from "node:crypto";
import type { ClaimedJob, JobRecord, QueueRepository } from "./types.js";

export class MemoryQueueRepository implements QueueRepository {
  readonly jobs = new Map<string, JobRecord>();
  private busy = Promise.resolve();

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.busy;
    let release!: () => void;
    this.busy = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async insert(job: JobRecord) {
    this.jobs.set(job.id, { ...job });
  }

  async claim(now: Date, leaseMs: number): Promise<ClaimedJob | null> {
    return this.locked(async () => {
      const candidates = [...this.jobs.values()]
        .filter(
          (job) =>
            (job.status === "pending" && job.availableAt <= now) ||
            (job.status === "processing" &&
              !!job.leaseExpiresAt &&
              job.leaseExpiresAt <= now),
        )
        .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime());
      const job = candidates[0];
      if (!job) return null;
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs);
      const updated: JobRecord = {
        ...job,
        status: "processing",
        attempts: job.attempts + 1,
        leaseToken,
        leaseExpiresAt,
        updatedAt: now,
        lastError: null,
      };
      this.jobs.set(job.id, updated);
      return { ...updated, leaseToken, leaseExpiresAt };
    });
  }

  async heartbeat(id: string, leaseToken: string, leaseMs: number, now: Date) {
    return this.locked(async () => {
      const job = this.jobs.get(id);
      if (!job || job.status !== "processing" || job.leaseToken !== leaseToken)
        return false;
      this.jobs.set(id, {
        ...job,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      });
      return true;
    });
  }

  async complete(id: string, leaseToken: string, now: Date) {
    return this.locked(async () => {
      const job = this.jobs.get(id);
      if (!job || job.status !== "processing" || job.leaseToken !== leaseToken)
        return false;
      this.jobs.set(id, {
        ...job,
        status: "completed",
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      });
      return true;
    });
  }

  async fail(input: {
    id: string;
    leaseToken: string;
    error: string;
    now: Date;
    nextAttemptAt: Date | null;
    dead: boolean;
  }) {
    return this.locked(async () => {
      const job = this.jobs.get(input.id);
      if (
        !job ||
        job.status !== "processing" ||
        job.leaseToken !== input.leaseToken
      )
        return false;
      this.jobs.set(input.id, {
        ...job,
        status: input.dead ? "dead" : "pending",
        leaseToken: null,
        leaseExpiresAt: null,
        availableAt: input.nextAttemptAt ?? job.availableAt,
        lastError: input.error,
        updatedAt: input.now,
      });
      return true;
    });
  }

  async get(id: string) {
    return this.jobs.get(id) ? { ...this.jobs.get(id)! } : null;
  }

  async requeue(id: string, now: Date) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status !== "dead") {
      throw new Error("Nur tote Jobs können erneut eingereiht werden");
    }
    const updated = {
      ...job,
      status: "pending" as const,
      attempts: 0,
      availableAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: now,
    };
    this.jobs.set(id, updated);
    return { ...updated };
  }
}
