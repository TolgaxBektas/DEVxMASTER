import {
  createDbFactory,
  createDrizzleAuditRepository,
  createDrizzleEventRepository,
  createEventBus,
  createRegistry,
  parseEnv,
} from "@xmaster-center/kernel";
import { createConfiguredStorage } from "@xmaster-center/integrations";
import { createPifProcessor } from "@xmaster-center/module-ingestion";
import {
  DrizzleQueueRepository,
  LeaseQueue,
  Scheduler,
  Worker,
} from "@xmaster-center/jobs";
import { createCrmModule } from "@xmaster-center/module-crm";
import { createSystemModule } from "@xmaster-center/module-system";
import { createBillingModule } from "@xmaster-center/module-billing";
import { createIngestionModule } from "@xmaster-center/module-ingestion";
import { createDrizzleIngestionRepository } from "@xmaster-center/module-ingestion";
import { createAssistantModule } from "@xmaster-center/module-assistant";
import type { ModuleRegistry } from "@xmaster-center/kernel";

const env = parseEnv();
const dbFactory = createDbFactory(env);
const db = dbFactory.get();
const storage = createConfiguredStorage(
  env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY && env.S3_BUCKET
    ? {
        endpoint: env.S3_ENDPOINT,
        accessKey: env.S3_ACCESS_KEY,
        secretKey: env.S3_SECRET_KEY,
        bucket: env.S3_BUCKET,
      }
    : undefined,
);
const audit = createDrizzleAuditRepository(db);
const eventRepository = createDrizzleEventRepository(db);
const queue = new LeaseQueue(new DrizzleQueueRepository(db));
let eventBus: ReturnType<typeof createEventBus>;
let registry: ModuleRegistry;
const system = createSystemModule({
  db,
  audit,
  events: eventRepository,
  queue,
  health: async () => [
    { id: "system", status: "healthy" },
    { id: "crm", status: "healthy" },
    { id: "billing", status: "healthy" },
    { id: "ingestion", status: "healthy" },
    { id: "assistant", status: "healthy" },
  ],
  navigation: (permissions) => registry.navigation({ permissions }),
});
const crm = createCrmModule({
  db,
  audit,
  publish: (input, executor) => eventBus.publish(input, executor),
  enqueue: (input) => queue.enqueue(input),
  getDocumentActuality: async (tenantId, documentId) =>
    (await createDrizzleIngestionRepository(db).getDocument(tenantId, documentId)).actualityStatus,
});
const billing = createBillingModule({
  db,
  audit,
  publish: (input, executor) => eventBus.publish(input, executor),
  transaction: (callback) => db.transaction(callback),
  storage,
  resolveAdSource: async (tenantId, occurrenceId) => {
    try {
      const occurrence = await createDrizzleIngestionRepository(db).getOccurrence(
        tenantId,
        occurrenceId,
      );
      return { imageKey: occurrence.imageKey ?? null, company: occurrence.company };
    } catch (error) {
      if (error instanceof Error && error.message === "Fundstelle nicht gefunden") {
        return null;
      }
      throw error;
    }
  },
});
const ingestion = createIngestionModule({
  db,
  audit,
  storage,
  transaction: (callback) => db.transaction(callback),
  repositoryForTransaction: (transactionDb) => createDrizzleIngestionRepository(transactionDb),
  enqueue: (input) => queue.enqueue({
    name: input.name,
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    payload: input.payload,
  }),
  processDocument: async (input) => {
    if (!env.PIF_SERVICE_TOKEN) throw new Error("PIF-Service-Token fehlt");
    const processor = createPifProcessor({
      storage,
      baseUrl: env.PIF_BASE_URL,
      serviceToken: env.PIF_SERVICE_TOKEN,
    });
    return processor(input);
  },
  discoverProposals: async ({ seedPages, searchTerms, maxResults }) => {
    if (!env.PIF_SERVICE_TOKEN) throw new Error("PIF-Service-Token fehlt");
    const response = await fetch(`${env.PIF_BASE_URL}/api/v1/discovery/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-token": env.PIF_SERVICE_TOKEN },
      body: JSON.stringify({ seed_pages: seedPages, search_terms: searchTerms, max_results: maxResults }),
    });
    if (!response.ok) throw new Error(`Quellensuche fehlgeschlagen (${response.status})`);
    const body = await response.json() as { proposals?: Array<Record<string, unknown>> };
    return (body.proposals ?? []).map((item) => ({
      url: String(item.url), score: Number(item.score ?? 0), metadata: item,
    }));
  },
  fetchSource: async ({ url }) => {
    if (!env.PIF_SERVICE_TOKEN) throw new Error("PIF-Service-Token fehlt");
    const response = await fetch(`${env.PIF_BASE_URL}/api/v1/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-token": env.PIF_SERVICE_TOKEN },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) throw new Error(`Quellenabruf fehlgeschlagen (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "source.pdf";
    return { bytes, filename };
  },
  revisitSource: async ({ url, fingerprint }) => {
    if (!env.PIF_SERVICE_TOKEN) throw new Error("PIF-Service-Token fehlt");
    const response = await fetch(`${env.PIF_BASE_URL}/api/v1/sources/revisit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-token": env.PIF_SERVICE_TOKEN },
      body: JSON.stringify({ url, fingerprint }),
    });
    if (!response.ok) throw new Error(`Quellenprüfung fehlgeschlagen (${response.status})`);
    return await response.json() as {
      httpStatus?: number | null; newPdfUrls?: string[]; newPdfCount?: number;
      changed?: boolean; fingerprint?: string | null; note?: string | null;
    };
  },
  publish: (input) => eventBus.publish(input),
  ...(env.INGESTION_WATCH_FOLDER?.trim()
    ? { watchFolderPath: env.INGESTION_WATCH_FOLDER }
    : {}),
});
const assistant = createAssistantModule({
  briefing: async () => ({
    overdueInvoices: 0,
    newLeads: 0,
    deadLetters: 0,
    costsMicros: 0,
    budgetMicros: 1_000_000,
  }),
  chat: async (_tenantId, text) => `ALEXIS Mock: ${text}`,
  audit: async () => undefined,
});
registry = createRegistry([system, crm, billing, ingestion, assistant]);
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
      ...(job.onFailure
        ? { onFailure: (error: unknown, context: unknown) => job.onFailure!(error, context) }
        : {}),
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
const schedules = [
  ...[...registry.jobs.values()]
    .filter((job) => job.schedule === "daily")
    .map((job) => ({
      name: job.name,
      intervalMs: 86_400_000,
      tenantId: "1",
      // Scheduled runs currently cover only the first tenant.
      payload: {},
    })),
  ...(env.INGESTION_WATCH_FOLDER?.trim()
    ? [...registry.jobs.values()]
      .filter((job) => job.schedule === "frequent")
      .map((job) => ({
        name: job.name,
        intervalMs: env.INGESTION_WATCH_INTERVAL_SECONDS * 1_000,
        tenantId: "1",
        // Scheduled runs currently cover only the first tenant.
        payload: {},
      }))
    : []),
];
scheduler.start(schedules);
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
