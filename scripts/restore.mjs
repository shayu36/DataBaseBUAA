import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPool } from "../server/db.mjs";
import { runMysqlTool } from "./mysql-tools.mjs";
const [input, target] = process.argv.slice(2);
if (!input || !/^campus_bike_restore_[a-zA-Z0-9_]+$/.test(target || ""))
  throw new Error(
    "Usage: node scripts/restore.mjs <backup.sql> campus_bike_restore_<new_name>",
  );
const file = resolve(input),
  sql = await readFile(file, "utf8");
if (/^\s*(USE\s|(?:CREATE|DROP)\s+DATABASE\b)/im.test(sql))
  throw new Error("Backup must not select or create another database.");
const pool = createPool({
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
try {
  // No IF NOT EXISTS: never restore over an existing database.
  await pool.query(
    `CREATE DATABASE \`${target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
  await runMysqlTool("mysql", ["--default-character-set=utf8mb4", target], {
    input: createReadStream(file),
  });
  const [[counts]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM \`${target}\`.users) users,(SELECT COUNT(*) FROM \`${target}\`.ride_orders) rides,(SELECT COUNT(*) FROM \`${target}\`.payments) payments`,
  );
  console.log(
    `Restored into NEW database ${target}: ${JSON.stringify(counts)}`,
  );
} finally {
  await pool.end();
}
