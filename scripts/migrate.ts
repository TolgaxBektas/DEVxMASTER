import { migrate } from "drizzle-orm/mysql2/migrator";
import { createDbFactory, parseEnv } from "../packages/kernel/src/index.ts";

const env = parseEnv();
const factory = createDbFactory(env);
await migrate(factory.get(), { migrationsFolder: "./drizzle" });
await factory.close();
console.log("[db] migrations applied");
