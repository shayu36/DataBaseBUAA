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
  const [v] = await pool.query(sql("metadata_views"));
  const [t] = await pool.query(sql("metadata_triggers"));
  const [p] = await pool.query(sql("metadata_routines"));
  const [[{ tables }]] = await pool.query(sql("metadata_tables_count"));
  console.log(
    `数据库结构已就绪：${tables} 张表、${v.length} 个视图、${t.length} 个触发器、${p.length} 个存储过程；触发器目录已核验。`,
  );
} finally {
  await pool.end();
}
