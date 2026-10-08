import { writeFile } from "node:fs/promises";
import { createPool } from "../server/db.mjs";
import { applySchema } from "./sql.mjs";
const pool = createPool({
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
try {
  if (process.env.DB_NAME !== "campus_bike")
    throw new Error(
      "Setup is restricted to campus_bike; old database is preserved.",
    );
  await applySchema(pool);
  const [[{ name }]] = await pool.query("SELECT DATABASE() name");
  const [v] = await pool.query(
    "SELECT TABLE_NAME name FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE()",
  );
  const [t] = await pool.query(
    "SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()",
  );
  const [p] = await pool.query(
    "SELECT ROUTINE_NAME name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()",
  );
  const [[{ tables }]] = await pool.query(
    "SELECT COUNT(*) tables FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' AND TABLE_NAME<>'carbon_ledger_legacy'",
  );
  await writeFile(
    new URL("../server/schema-objects.json", import.meta.url),
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
