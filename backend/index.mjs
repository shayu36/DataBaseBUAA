import { createPool, ledgerTransaction, errorCodes } from "./db.mjs";
import { createApp } from "./app.mjs";
import { sql } from "./sql-statements.mjs";
const pool = createPool();
const versionError =
  "SCHEMA_VERSION_MISMATCH：数据库版本不匹配，请先核对 README 中的初始化和迁移说明。";
try {
  const [[{ compatible }]] = await pool.query(sql("schema_version_compatible"));
  if (!compatible) throw new Error(versionError);
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
