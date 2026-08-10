import { randomUUID } from "node:crypto";
import { retryDelay, type BackoffOptions } from "./backoff.js";
import type {
  ClaimedJob,
  JobHandler,
  JobRecord,
  QueueRepository,
} from "./types.js";

export type QueueOptions = {
  leaseMs?: number;
  backoff?: BackoffOptions;
  now?: () => Date;
  random?: () => number;
};

export class LeaseQueue {
  readonly leaseMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly repository: QueueRepository,
    options: QueueOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
    this.backoff = options.backoff ?? {};
    this.random = options.random ?? Math.random;
  }
  private readonly backoff: BackoffOptions;
  private readonly random: () => number;

  async enqueue(input: {
    name: string;
    payload: unknown;
    tenantId?: string | null;
    maxAttempts?: number;
    availableAt?: Date;
  }): Promise<JobRecord> {
    const now = this.now();
    const job: JobRecord = {
      id: randomUUID(),
      tenantId: input.tenantId ?? null,
      name: input.name,
      payload: input.payload,
      status: "pending",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 5,
      availableAt: input.availableAt ?? now,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.insert(job);
    return job;
  }

  claimNext(workerId = "worker"): Promise<ClaimedJob | null> {
    return this.repository.claim(this.now(), this.leaseMs, workerId);
  }

  heartbeat(job: ClaimedJob): Promise<boolean> {
    return this.repository.heartbeat(
      job.id,
      job.leaseToken,
      this.leaseMs,
      this.now(),
    );
  }

  async complete(job: ClaimedJob): Promise<boolean> {
    return this.repository.complete(job.id, job.leaseToken, this.now());
  }

  async fail(
    job: ClaimedJob,
    error: unknown,
    maxAttempts = job.maxAttempts,
  ): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error);
    const dead = job.attempts >= maxAttempts;
    const nextAttemptAt = dead
      ? null
      : new Date(
          this.now().getTime() +
            retryDelay(job.attempts, {
              ...this.backoff,
              random: this.random,
            }),
        );
    return this.repository.fail({
      id: job.id,
      leaseToken: job.leaseToken,
      error: message,
      now: this.now(),
      nextAttemptAt,
      dead,
    });
  }
}

export function createJobHandlerContext(
  queue: LeaseQueue,
  job: ClaimedJob,
  signal: AbortSignal,
) {
  return { job, signal, heartbeat: () => queue.heartbeat(job) };
}
