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
        await this.queue.fail(job, `Kein Handler für Job ${job.name}`, 1);
        continue;
      }
      const controller = new AbortController();
      const timer = handler.timeoutMs
        ? setTimeout(() => controller.abort(), handler.timeoutMs)
        : undefined;
      try {
        await handler.handle(
          job.payload,
          createJobHandlerContext(this.queue, job, controller.signal),
        );
        await this.queue.complete(job);
      } catch (error) {
        const maxAttempts = handler.maxAttempts ?? job.maxAttempts;
        const effectiveMaxAttempts = error instanceof NonRetryableError ? 1 : maxAttempts;
        const terminal = job.attempts >= effectiveMaxAttempts;
        await this.queue.fail(
          job,
          error,
          effectiveMaxAttempts,
        );
        if (terminal && handler.onFailure) {
          try {
            await handler.onFailure(error, createJobHandlerContext(
              this.queue,
              job,
              controller.signal,
            ));
          } catch (failureError) {
            console.error(
              `[worker] terminal failure handling failed for ${job.name} ${job.id}`,
              failureError,
            );
          }
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
}
