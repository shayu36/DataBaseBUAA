import { join } from "node:path";
import { projectRoot } from "./mysql-tools.mjs";
import { writeLockedMysqlDump } from "./dump.mjs";
import { createPool } from "../backend/db.mjs";

if (process.env.DB_NAME !== "campus_bike")
  throw new Error("Snapshot is restricted to campus_bike.");
const target = join(projectRoot, "database", "demo-snapshot.sql");
const pool = createPool({
  database: process.env.DB_NAME,
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
let size;
try {
  size = await writeLockedMysqlDump(pool, target, process.env.DB_NAME);
} finally {
  await pool.end();
}
console.log(`Demo snapshot refreshed: ${target} (${size} bytes)`);
