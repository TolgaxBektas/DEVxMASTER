export type JobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "dead";

export type JobRecord = {
  id: string;
  tenantId: string | null;
  name: string;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ClaimedJob = JobRecord & {
  leaseToken: string;
  leaseExpiresAt: Date;
};

export type QueueRepository = {
  insert(job: JobRecord): Promise<void>;
  claim(
    now: Date,
    leaseMs: number,
    workerId: string,
  ): Promise<ClaimedJob | null>;
  heartbeat(
    id: string,
    leaseToken: string,
    leaseMs: number,
    now: Date,
  ): Promise<boolean>;
  complete(id: string, leaseToken: string, now: Date): Promise<boolean>;
  fail(input: {
    id: string;
    leaseToken: string;
    error: string;
    now: Date;
    nextAttemptAt: Date | null;
    dead: boolean;
  }): Promise<boolean>;
  requeue(id: string, now: Date): Promise<JobRecord | null>;
  get(id: string): Promise<JobRecord | null>;
};

export type JobHandlerContext = {
  job: ClaimedJob;
  heartbeat(): Promise<boolean>;
  signal: AbortSignal;
};

export type JobHandler = {
  name: string;
  handle(payload: unknown, context: JobHandlerContext): Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
};
