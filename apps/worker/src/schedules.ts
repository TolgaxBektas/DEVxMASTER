import type { Env, ModuleJob } from "@xmaster-center/kernel";
import type { Schedule } from "@xmaster-center/jobs";

type WorkerScheduleEnvironment = Pick<
  Env,
  "INGESTION_WATCH_FOLDER" | "INGESTION_WATCH_INTERVAL_SECONDS" | "WORKER_SCHEDULES_ENABLED"
>;

export function buildWorkerSchedules(
  jobs: Iterable<Pick<ModuleJob, "name" | "schedule">>,
  env: WorkerScheduleEnvironment,
): Schedule[] {
  if (!env.WORKER_SCHEDULES_ENABLED) return [];
  const jobList = [...jobs];
  return [
    ...jobList
      .filter((job) => job.schedule === "daily")
      .map((job) => ({
        name: job.name,
        intervalMs: 86_400_000,
        tenantId: "1",
        payload: {},
      })),
    ...(env.INGESTION_WATCH_FOLDER?.trim()
      ? jobList
        .filter((job) => job.schedule === "frequent")
        .map((job) => ({
          name: job.name,
          intervalMs: env.INGESTION_WATCH_INTERVAL_SECONDS * 1_000,
          tenantId: "1",
          payload: {},
        }))
      : []),
  ];
}
