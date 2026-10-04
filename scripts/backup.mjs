import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot, runMysqlTool } from "./mysql-tools.mjs";
const destination = join(projectRoot, "backups");
await mkdir(destination, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = join(destination, `campus_bike-${stamp}.sql`);
await runMysqlTool("mysqldump", [
  "--single-transaction",
  "--routines",
  "--triggers",
  "--set-gtid-purged=OFF",
  "--no-tablespaces",
  `--result-file=${file}`,
  process.env.DB_NAME,
]);
console.log(`Backup saved: ${file} (${(await stat(file)).size} bytes)`);
