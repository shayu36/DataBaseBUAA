import { readFile } from "node:fs/promises";
import { createPool } from "../backend/db.mjs";
import { sql } from "../backend/sql-statements.mjs";
const pool = createPool(
  process.argv[2]
    ? {
        database: process.argv[2],
        user: process.env.DB_ADMIN_USER,
        password: process.env.DB_ADMIN_PASSWORD,
      }
    : {},
);
const checks = await readFile(
  new URL("../database/invariant-checks.sql", import.meta.url),
  "utf8",
);
const c = await pool.getConnection();
try {
  await c.query(sql("consistent_snapshot"));
  let errors = 0;
  const [results] = await c.query(checks);
  for (const result of results) {
    errors += Number(result.errors);
    console.log(
      (Number(result.errors) === 0 ? "PASS " : "FAIL ") +
        result.name +
        ": " +
        result.errors,
    );
  }
  const [[totals]] = await c.query(sql("check_totals"));
  console.log(JSON.stringify(totals));
  await c.commit();
  if (errors) process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
