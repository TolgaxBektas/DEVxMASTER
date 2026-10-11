import { describe, expect, it } from "vitest";
import { buildWorkerSchedules } from "./schedules.js";

const jobs = [
  { name: "daily-job", schedule: "daily" },
  { name: "frequent-job", schedule: "frequent" },
  { name: "manual-job" },
];

const environment = {
  WORKER_SCHEDULES_ENABLED: true,
  INGESTION_WATCH_FOLDER: "/watch",
  INGESTION_WATCH_INTERVAL_SECONDS: 30,
};

describe("Worker-Zeitpläne", () => {
  it("baut bei deaktivierten Zeitplänen keine Einträge", () => {
    expect(buildWorkerSchedules(jobs, {
      ...environment,
      WORKER_SCHEDULES_ENABLED: false,
      WORKER_SCHEDULES: "daily-job",
    })).toEqual([]);
  });

  it("behält tägliche und konfigurierte häufige Zeitpläne bei", () => {
    expect(buildWorkerSchedules(jobs, environment)).toEqual([
      {
        name: "daily-job",
        intervalMs: 86_400_000,
        tenantId: "1",
        payload: {},
      },
      {
        name: "frequent-job",
        intervalMs: 30_000,
        tenantId: "1",
        payload: {},
      },
    ]);
  });

  it("lässt häufige Zeitpläne ohne Überwachungsordner weg", () => {
    expect(buildWorkerSchedules(jobs, {
      ...environment,
      INGESTION_WATCH_FOLDER: "",
    }).map(({ name }) => name)).toEqual(["daily-job"]);
  });

  it("filtert Zeitpläne nach der optionalen Job-Allowlist", () => {
    expect(buildWorkerSchedules(jobs, {
      ...environment,
      WORKER_SCHEDULES: " frequent-job , daily-job ",
    }).map(({ name }) => name)).toEqual(["daily-job", "frequent-job"]);
  });

  it("lehnt unbekannte Jobnamen ab und nennt die gültigen Namen", () => {
    expect(() => buildWorkerSchedules(jobs, {
      ...environment,
      WORKER_SCHEDULES: "daily-job, unbekannt",
    })).toThrow(
      "Ungültige WORKER_SCHEDULES: unbekannt. Gültige geplante Jobnamen: daily-job, frequent-job",
    );
  });

  it("lehnt unbekannte Jobnamen auch bei deaktivierten Zeitplänen ab", () => {
    expect(() => buildWorkerSchedules(jobs, {
      ...environment,
      WORKER_SCHEDULES_ENABLED: false,
      WORKER_SCHEDULES: "unknown-job",
    })).toThrow("Gültige geplante Jobnamen: daily-job, frequent-job");
  });

  it("behandelt eine leere Allowlist wie eine nicht gesetzte", () => {
    expect(buildWorkerSchedules(jobs, {
      ...environment,
      WORKER_SCHEDULES: "   ",
    })).toEqual(buildWorkerSchedules(jobs, environment));
  });
});
