import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { createPool } from "../backend/db.mjs";
import { sql as statement } from "../backend/sql-statements.mjs";
import { runMysqlTool } from "./mysql-tools.mjs";
const [input, target] = process.argv.slice(2);
if (!input || !/^campus_bike_restore_[a-zA-Z0-9_]+$/.test(target || ""))
  throw new Error(
    "Usage: node scripts/restore.mjs <backup.sql> campus_bike_restore_<new_name>",
  );
const file = resolve(input);
const lines = createInterface({
  input: createReadStream(file),
  crlfDelay: Infinity,
});
for await (const line of lines) {
  if (/^\s*(USE\s|(?:CREATE|DROP)\s+DATABASE\b)/i.test(line))
    throw new Error("Backup must not select or create another database.");
}
const pool = createPool({
  database: undefined,
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
try {
  // No IF NOT EXISTS: never restore over an existing database.
  await pool.query(statement("create_restore_database"), [target]);
  await runMysqlTool("mysql", ["--default-character-set=utf8mb4", target], {
    input: createReadStream(file),
  });
  const restored = createPool({
    database: target,
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  });
  let counts;
  try {
    [[counts]] = await restored.query(statement("check_totals"));
  } finally {
    await restored.end();
  }
  console.log(
    `Restored into NEW database ${target}: ${JSON.stringify(counts)}`,
  );
} finally {
  await pool.end();
}
