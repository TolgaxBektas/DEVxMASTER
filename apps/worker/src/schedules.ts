import type { Env, ModuleJob } from "@xmaster-center/kernel";
import type { Schedule } from "@xmaster-center/jobs";

type WorkerScheduleEnvironment = Pick<
  Env,
  | "INGESTION_WATCH_FOLDER"
  | "INGESTION_WATCH_INTERVAL_SECONDS"
  | "WORKER_SCHEDULES_ENABLED"
  | "WORKER_SCHEDULES"
>;

export function buildWorkerSchedules(
  jobs: Iterable<Pick<ModuleJob, "name" | "schedule">>,
  env: WorkerScheduleEnvironment,
): Schedule[] {
  const jobList = [...jobs];
  const configuredNames = env.WORKER_SCHEDULES?.trim();
  const selectedNames = configuredNames
    ? new Set(configuredNames.split(",").map((name) => name.trim()).filter(Boolean))
    : undefined;
  if (selectedNames) {
    const validNames = [...new Set(
      jobList
        .filter((job) => job.schedule === "daily" || job.schedule === "frequent")
        .map((job) => job.name),
    )].sort();
    const unknownNames = [...selectedNames].filter((name) => !validNames.includes(name));
    if (unknownNames.length > 0) {
      throw new Error(
        `Ungültige WORKER_SCHEDULES: ${unknownNames.join(", ")}. `
        + `Gültige geplante Jobnamen: ${validNames.join(", ") || "keine"}`,
      );
    }
  }
  if (!env.WORKER_SCHEDULES_ENABLED) return [];
  const isSelected = (name: string) => !selectedNames || selectedNames.has(name);
  return [
    ...jobList
      .filter((job) => job.schedule === "daily" && isSelected(job.name))
      .map((job) => ({
        name: job.name,
        intervalMs: 86_400_000,
        tenantId: "1",
        payload: {},
      })),
    ...(env.INGESTION_WATCH_FOLDER?.trim()
      ? jobList
        .filter((job) => job.schedule === "frequent" && isSelected(job.name))
        .map((job) => ({
          name: job.name,
          intervalMs: env.INGESTION_WATCH_INTERVAL_SECONDS * 1_000,
          tenantId: "1",
          payload: {},
        }))
      : []),
  ];
}
