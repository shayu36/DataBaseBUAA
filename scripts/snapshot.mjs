import { stat } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot, runMysqlTool } from "./mysql-tools.mjs";

if (process.env.DB_NAME !== "campus_bike")
  throw new Error("Snapshot is restricted to campus_bike.");
const target = join(projectRoot, "database", "demo-snapshot.sql");
await runMysqlTool("mysqldump", [
  "--single-transaction",
  "--routines",
  "--triggers",
  "--set-gtid-purged=OFF",
  "--no-tablespaces",
  `--result-file=${target}`,
  process.env.DB_NAME,
]);
console.log(
  `Demo snapshot refreshed: ${target} (${(await stat(target)).size} bytes)`,
);
