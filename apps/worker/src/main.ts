import {
  createDbFactory,
  createDrizzleAuditRepository,
  createDrizzleEventRepository,
  createEventBus,
  createRegistry,
  parseEnv,
} from "@xmaster-center/kernel";
import {
  DrizzleQueueRepository,
  LeaseQueue,
  Scheduler,
  Worker,
} from "@xmaster-center/jobs";
import { createCrmModule } from "@xmaster-center/module-crm";
import { createSystemModule } from "@xmaster-center/module-system";
import type { ModuleRegistry } from "@xmaster-center/kernel";

const env = parseEnv();
const dbFactory = createDbFactory(env);
const db = dbFactory.get();
const audit = createDrizzleAuditRepository(db);
const eventRepository = createDrizzleEventRepository(db);
const queue = new LeaseQueue(new DrizzleQueueRepository(db));
let eventBus: ReturnType<typeof createEventBus>;
let registry: ModuleRegistry;
const system = createSystemModule({
  db,
  audit,
  health: async () => [{ id: "system", status: "healthy" }],
  navigation: (permissions) => registry.navigation({ permissions }),
});
const crm = createCrmModule({
  db,
  audit,
  publish: (input, executor) => eventBus.publish(input, executor),
  enqueue: (input) => queue.enqueue(input),
});
registry = createRegistry([system, crm]);
eventBus = createEventBus(
  eventRepository,
  [...registry.events.entries()].flatMap(([name, items]) =>
    items
      .filter((item) => item.direction === "subscribed" && item.handle)
      .map((item) => ({
        name,
        handle: item.handle as (event: unknown) => Promise<void>,
      })),
  ),
);
const handlers = new Map(
  [...registry.jobs].map(([name, job]) => [
    name,
    {
      name,
      ...(job.maxAttempts === undefined
        ? {}
        : { maxAttempts: job.maxAttempts }),
      ...(job.timeoutMs === undefined ? {} : { timeoutMs: job.timeoutMs }),
      handle: (payload: unknown, context: unknown) =>
        job.handle(payload, context),
    },
  ]),
);
const worker = new Worker(queue, handlers);
const scheduler = new Scheduler(queue);
const abort = new AbortController();
const dispatchLoop = async () => {
  while (!abort.signal.aborted) {
    const count = await eventBus.dispatch(100);
    if (count) console.log(`[worker] events delivered=${count}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
};
console.log("[worker] starting job loop and event dispatcher");
scheduler.start([]);
void worker.run({
  workerId: `worker-${process.pid}`,
  signal: abort.signal,
  pollMs: 1_000,
});
void dispatchLoop();

const shutdown = async () => {
  abort.abort();
  worker.stop();
  scheduler.stop();
  await dbFactory.close();
  console.log("[worker] stopped");
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
