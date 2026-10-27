import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "./mysql-tools.mjs";
import { writeMysqlDump } from "./dump.mjs";
const destination = join(projectRoot, "backups");
await mkdir(destination, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = join(
  destination,
  `campus_bike-${stamp}-${randomBytes(4).toString("hex")}.sql`,
);
const size = await writeMysqlDump(file, process.env.DB_NAME);
console.log(`Backup saved: ${file} (${size} bytes)`);
