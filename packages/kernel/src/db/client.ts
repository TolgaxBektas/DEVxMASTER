import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import type { MySql2Database } from "drizzle-orm/mysql2";

import type { Env } from "../env.js";
import { kernelSchema } from "./schema.js";

export type KernelDb = MySql2Database<typeof kernelSchema>;

export type DbHandle = {
  db: KernelDb;
  close: () => Promise<void>;
};

export function createDbFactory(env: Pick<Env, "DATABASE_URL">) {
  let handle: DbHandle | undefined;
  return {
    get(): KernelDb {
      if (!handle) handle = createDb(env);
      return handle.db;
    },
    async close() {
      await handle?.close();
      handle = undefined;
    },
  };
}

export function createDb(env: Pick<Env, "DATABASE_URL">): DbHandle {
  const pool = mysql.createPool(env.DATABASE_URL);
  return {
    db: drizzle(pool, { schema: kernelSchema, mode: "default" }),
    close: () => pool.end(),
  };
}
