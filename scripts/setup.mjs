import { mkdir, writeFile } from "node:fs/promises";
import { createPool } from "../backend/db.mjs";
import { applySchema } from "./sql.mjs";
import { sql } from "../backend/sql-statements.mjs";
import { assertMysqlVersion } from "./mysql-version.mjs";
const pool = createPool({
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
try {
  if (process.env.DB_NAME !== "campus_bike")
    throw new Error(
      "Setup is restricted to campus_bike; old database is preserved.",
    );
  await assertMysqlVersion(pool);
  await applySchema(pool);
  const [[{ name }]] = await pool.query(sql("current_database"));
  const [v] = await pool.query(sql("metadata_views"));
  const [t] = await pool.query(sql("metadata_triggers"));
  const [p] = await pool.query(sql("metadata_routines"));
  const [[{ tables }]] = await pool.query(sql("metadata_tables_count"));
  await mkdir(new URL("../.runtime/", import.meta.url), { recursive: true });
  await writeFile(
    new URL("../.runtime/schema-objects.json", import.meta.url),
    JSON.stringify(
      {
        database: name,
        generated_at: new Date().toISOString(),
        views: v.map((x) => x.name),
        triggers: t.map((x) => x.name),
        procedures: p.map((x) => x.name),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Schema ready: ${tables} tables, ${v.length} views, ${t.length} triggers, ${p.length} procedures; read-only object catalogue refreshed.`,
  );
} finally {
  await pool.end();
}
