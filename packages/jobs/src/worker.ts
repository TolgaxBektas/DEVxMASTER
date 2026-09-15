import type { JobHandler } from "./types.js";
import { NonRetryableError } from "@xmaster-center/kernel";
import { createJobHandlerContext, LeaseQueue } from "./queue.js";

export type WorkerOptions = {
  workerId: string;
  pollMs?: number;
  signal?: AbortSignal;
};

export class Worker {
  private stopped = false;
  constructor(
    private readonly queue: LeaseQueue,
    private readonly handlers: ReadonlyMap<string, JobHandler>,
  ) {}

  stop() {
    this.stopped = true;
  }

  async run(options: WorkerOptions): Promise<void> {
    const signal = options.signal ?? new AbortController().signal;
    while (!this.stopped && !signal.aborted) {
      const job = await this.queue.claimNext(options.workerId);
      if (!job) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.pollMs ?? 1_000),
        );
        continue;
      }
      const handler = this.handlers.get(job.name);
      if (!handler) {
        const failed = await this.queue.fail(job, `Kein Handler für Job ${job.name}`, 1);
        if (!failed) {
          console.error(
            `[worker] Lease für Job ${job.name} (${job.id}) beim Fehlschlagen nicht mehr gehalten`,
          );
        }
        continue;
      }
      const controller = new AbortController();
      const timer = handler.timeoutMs
        ? setTimeout(() => controller.abort(), handler.timeoutMs)
        : undefined;
      let leaseLost = false;
      let heartbeatRunning = false;
      let heartbeatInterval!: ReturnType<typeof setInterval>;
      const heartbeat = async () => {
        if (leaseLost || heartbeatRunning) return;
        heartbeatRunning = true;
        try {
          const held = await this.queue.heartbeat(job);
          if (!held) {
            leaseLost = true;
            controller.abort();
            clearInterval(heartbeatInterval);
            console.error(
              `[worker] Lease für Job ${job.name} (${job.id}) verloren; Handler abgebrochen`,
            );
          }
        } finally {
          heartbeatRunning = false;
        }
      };
      heartbeatInterval = setInterval(
        () => void heartbeat(),
        Math.max(1_000, Math.floor(this.queue.leaseMs / 3)),
      );
      try {
        await handler.handle(
          job.payload,
          createJobHandlerContext(this.queue, job, controller.signal),
        );
        if (!leaseLost) {
          const completed = await this.queue.complete(job);
          if (!completed) {
            console.error(
              `[worker] Lease für Job ${job.name} (${job.id}) beim Abschließen nicht mehr gehalten`,
            );
          }
        }
      } catch (error) {
        if (!leaseLost) {
          const maxAttempts = handler.maxAttempts ?? job.maxAttempts;
          const effectiveMaxAttempts = error instanceof NonRetryableError ? 1 : maxAttempts;
          const terminal = job.attempts >= effectiveMaxAttempts;
          const failed = await this.queue.fail(
            job,
            error,
            effectiveMaxAttempts,
          );
          if (!failed) {
            console.error(
              `[worker] Lease für Job ${job.name} (${job.id}) beim Fehlschlagen nicht mehr gehalten`,
            );
          } else if (terminal && handler.onFailure) {
            try {
              await handler.onFailure(error, createJobHandlerContext(
                this.queue,
                job,
                controller.signal,
              ));
            } catch (failureError) {
              console.error(
                `[worker] Terminale Fehlerbehandlung für Job ${job.name} (${job.id}) fehlgeschlagen`,
                failureError,
              );
            }
          }
        }
      } finally {
        if (timer) clearTimeout(timer);
        clearInterval(heartbeatInterval);
      }
    }
  }
}
