import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "./mysql-tools.mjs";
import { writeLockedMysqlDump } from "./dump.mjs";
import { createPool } from "../backend/db.mjs";
const destination = join(projectRoot, "backups");
await mkdir(destination, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = join(
  destination,
  `campus_bike-${stamp}-${randomBytes(4).toString("hex")}.sql`,
);
const pool = createPool({
  database: process.env.DB_NAME,
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
let size;
try {
  size = await writeLockedMysqlDump(pool, file, process.env.DB_NAME);
} finally {
  await pool.end();
}
console.log(`Backup saved: ${file} (${size} bytes)`);
