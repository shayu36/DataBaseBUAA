import { join } from "node:path";
import { projectRoot } from "./mysql-tools.mjs";
import { writeMysqlDump } from "./dump.mjs";

if (process.env.DB_NAME !== "campus_bike")
  throw new Error("Snapshot is restricted to campus_bike.");
const target = join(projectRoot, "database", "demo-snapshot.sql");
const size = await writeMysqlDump(target, process.env.DB_NAME);
console.log(`Demo snapshot refreshed: ${target} (${size} bytes)`);
