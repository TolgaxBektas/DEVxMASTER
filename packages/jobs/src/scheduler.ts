import { LeaseQueue } from "./queue.js";

export type Schedule = {
  name: string;
  intervalMs: number;
  payload: unknown;
  tenantId?: string | null;
};

export class Scheduler {
  private timers: ReturnType<typeof setInterval>[] = [];
  constructor(private readonly queue: LeaseQueue) {}

  start(schedules: readonly Schedule[]) {
    for (const schedule of schedules) {
      const timer = setInterval(() => {
        void this.queue.enqueue(schedule);
      }, schedule.intervalMs);
      this.timers.push(timer);
    }
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
