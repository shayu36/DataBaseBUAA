import { createPool, ledgerTransaction } from "./db.mjs";
import { createApp } from "./app.mjs";
const pool = createPool();
await pool.query("SELECT 1");
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
  ).catch((e) => console.error("[snapshot]", e.code || e.message));
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
