import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

const requiredEnvironment: NodeJS.ProcessEnv = {
  DATABASE_URL: "mysql://user:password@localhost:3306/xmaster_center",
  JWT_SECRET: "0123456789abcdef",
  PUBLIC_APP_ORIGIN: "http://localhost",
};

describe("WORKER_SCHEDULES_ENABLED", () => {
  it("ist standardmäßig aktiviert", () => {
    expect(parseEnv(requiredEnvironment).WORKER_SCHEDULES_ENABLED).toBe(true);
  });

  it.each(["false", "FALSE", "0"])("akzeptiert %s als deaktiviert", (value) => {
    expect(parseEnv({
      ...requiredEnvironment,
      WORKER_SCHEDULES_ENABLED: value,
    }).WORKER_SCHEDULES_ENABLED).toBe(false);
  });

  it.each(["true", "TRUE", "1"])("akzeptiert %s als aktiviert", (value) => {
    expect(parseEnv({
      ...requiredEnvironment,
      WORKER_SCHEDULES_ENABLED: value,
    }).WORKER_SCHEDULES_ENABLED).toBe(true);
  });

  it("lehnt andere Werte ab", () => {
    expect(() => parseEnv({
      ...requiredEnvironment,
      WORKER_SCHEDULES_ENABLED: "yes",
    })).toThrow("Ungültige Umgebungsvariablen");
  });
});

describe("INGESTION_AUTO_PROCESS", () => {
  it("ist standardmäßig aktiviert", () => {
    expect(parseEnv(requiredEnvironment).INGESTION_AUTO_PROCESS).toBe(true);
  });

  it.each(["false", "FALSE", "0"])("akzeptiert %s als deaktiviert", (value) => {
    expect(parseEnv({
      ...requiredEnvironment,
      INGESTION_AUTO_PROCESS: value,
    }).INGESTION_AUTO_PROCESS).toBe(false);
  });

  it.each(["true", "TRUE", "1"])("akzeptiert %s als aktiviert", (value) => {
    expect(parseEnv({
      ...requiredEnvironment,
      INGESTION_AUTO_PROCESS: value,
    }).INGESTION_AUTO_PROCESS).toBe(true);
  });

  it("lehnt andere Werte ab", () => {
    expect(() => parseEnv({
      ...requiredEnvironment,
      INGESTION_AUTO_PROCESS: "yes",
    })).toThrow("Ungültige Umgebungsvariablen");
  });
});

describe("WORKER_SCHEDULES", () => {
  it("ist optional und bewahrt den Listenwert auf", () => {
    expect(parseEnv(requiredEnvironment).WORKER_SCHEDULES).toBeUndefined();
    expect(parseEnv({
      ...requiredEnvironment,
      WORKER_SCHEDULES: "ingestion.search_keys.run, ingestion.source.fetch",
    }).WORKER_SCHEDULES).toBe("ingestion.search_keys.run, ingestion.source.fetch");
  });
});
