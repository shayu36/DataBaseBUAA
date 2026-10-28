import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sql } from "./sql-statements.mjs";
import { pageById } from "./pagination.mjs";

export async function rideHistory(pool, actor, status, before = null) {
  const [rows] = await pool.query(sql("ride_history_own"), [
    actor.id,
    status,
    status,
    before,
    before,
  ]);
  return pageById(rows, "rides");
}

export async function paymentHistory(pool, actor, before = null) {
  const [rows] = await pool.query(sql("payment_history_own"), [
    actor.id,
    before,
    before,
  ]);
  return pageById(rows, "payments");
}

export async function dispatchHistory(pool, before = null) {
  const [rows] = await pool.query(sql("dispatch_history"), [before, before]);
  return pageById(rows, "dispatches");
}

export async function ticketHistory(pool, actor, before = null) {
  const all = actor.role !== "STUDENT";
  const [rows] = await pool.query(
    sql(all ? "ticket_history_all" : "ticket_history_own"),
    all ? [before, before] : [actor.id, before, before],
  );
  return pageById(rows, "tickets");
}

const fields = [
  "id",
  "bike_code",
  "start_zone_name",
  "end_zone_name",
  "status",
  "distance_m",
  "amount_cents",
];
function csvCell(value) {
  const text = String(value ?? "");
  const prefix = /^[\t\r\n]|^[\u0000-\u0020]*[=+\-@]/.test(text) ? "'" : "";
  return `"${prefix}${text.replaceAll('"', '""')}"`;
}

export async function exportRides(pool, actor, status, response) {
  const connection = await pool.getConnection();
  let complete = false;
  try {
    const rows = connection.connection
      .query(sql("ride_export_own"), [actor.id, status, status])
      .stream();
    const csv = new Transform({
      writableObjectMode: true,
      transform(row, _encoding, callback) {
        callback(
          null,
          fields.map((field) => csvCell(row[field])).join(",") + "\r\n",
        );
      },
    });
    response.attachment("青行骑行订单.csv");
    response.set("Content-Type", "text/csv; charset=utf-8");
    response.write("\ufeff" + fields.join(",") + "\r\n");
    await pipeline(rows, csv, response);
    complete = true;
  } finally {
    if (complete) connection.release();
    else connection.destroy();
  }
}
