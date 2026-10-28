import {
  createPool,
  ledgerTransaction,
  errorCodes,
  withSchemaLock,
} from "./db.mjs";
import { createApp } from "./app.mjs";
import { sessionSecret } from "./config.mjs";
import { sql } from "./sql-statements.mjs";
import { campus, campusDefinition } from "./campus-data.mjs";
import {
  loadProcedureSources,
  procedureRevision,
} from "./procedure-revision.mjs";
sessionSecret();
const pool = createPool();
const versionError =
  "SCHEMA_VERSION_MISMATCH：数据库结构或存储过程版本不匹配，请先核对 README 中的初始化和迁移说明。";
try {
  const revision = procedureRevision(await loadProcedureSources());
  await withSchemaLock(pool, async (connection) => {
    const [[row]] = await connection.query(sql("schema_version_compatible"), [
      revision,
    ]);
    if (!row.compatible) throw new Error(versionError);
    const [[map]] = await connection.query(sql("campus_map_compatible"), [
      campus.version,
    ]);
    if (!map.compatible)
      throw new Error(
        "CAMPUS_MAP_VERSION_MISMATCH：校园地图未升级，请先备份并按 README 执行初始化或迁移。",
      );
    const [differences] = await connection.query(
      sql("campus_restriction_differences"),
      [campusDefinition],
    );
    if (differences.length)
      console.warn(
        `校园地图有 ${differences.length} 条默认禁行路段与当前数据库不同；请运行 npm run check 核对。`,
      );
  });
} catch (error) {
  await pool.end();
  if (error.code === "ER_NO_SUCH_TABLE")
    throw new Error(versionError, { cause: error });
  throw error;
}
const host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 5188);
const server = createApp(pool).listen(port, host, () =>
  console.log(
    "Qingxing ready at http://" +
      host +
      ":" +
      port +
      " · campus-bike simulation",
  ),
);
const capture = () =>
  ledgerTransaction(pool, (c) =>
    c.query("CALL sp_capture_zone_snapshots()"),
  ).catch((e) =>
    console.error(
      "[snapshot]",
      e.code || e.message,
      ...(e instanceof AggregateError ? [errorCodes(e).join(", ")] : []),
    ),
  );
await capture();
const timer = setInterval(capture, 60000);
timer.unref();
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
