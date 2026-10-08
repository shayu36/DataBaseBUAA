import {
  aggregateHotspots,
  dispatchSuggestions,
  bikeRisks,
  buildLeaderboard,
} from "./analytics.mjs";
export async function dashboard(pool, user) {
  // One MVCC snapshot avoids mixtures of pre/post-transaction vehicle and order state.
  const c = await pool.getConnection();
  try {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await c.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    const [zones] = await c.query("SELECT * FROM v_zone_inventory ORDER BY id");
    const [bikes] = await c.query(
      "SELECT b.*,z.name zone_name FROM bikes b LEFT JOIN parking_zones z ON z.id=b.current_zone_id ORDER BY b.id",
    );
    const [rides] = await c.query(
      "SELECT * FROM v_ride_details WHERE user_id=? ORDER BY id DESC",
      [user.id],
    );
    const [payments] = await c.query(
      "SELECT p.* FROM payments p JOIN ride_orders r ON r.id=p.order_id WHERE r.user_id=? ORDER BY p.id DESC",
      [user.id],
    );
    const [staff] =
      user.role === "STUDENT"
        ? [[]]
        : await c.query(
            "SELECT s.*,u.email FROM staff s JOIN users u ON u.id=s.user_id ORDER BY s.id",
          );
    const [dispatches] =
      user.role === "STUDENT"
        ? [[]]
        : await c.query(
            "SELECT t.*,s.name staff_name,a.name source_name,b.name target_name FROM dispatch_tasks t LEFT JOIN staff s ON s.id=t.staff_id JOIN parking_zones a ON a.id=t.source_zone_id JOIN parking_zones b ON b.id=t.target_zone_id ORDER BY t.id DESC",
          );
    const [items] = dispatches.length
      ? await c.query("SELECT * FROM dispatch_bikes")
      : [[]];
    for (const t of dispatches)
      t.bike_ids = items
        .filter((i) => i.task_id === t.id)
        .map((i) => i.bike_id);
    const where = user.role === "STUDENT" ? " WHERE t.reporter_id=?" : "";
    const [tickets] = await c.query(
      "SELECT t.*,b.code bike_code,s.name staff_name FROM maintenance_tickets t JOIN bikes b ON b.id=t.bike_id LEFT JOIN staff s ON s.id=t.staff_id" +
        where +
        " ORDER BY t.id DESC",
      user.role === "STUDENT" ? [user.id] : [],
    );
    const [[carbon]] = await c.query(
      "SELECT points,carbon_kg,distance_m FROM v_user_carbon WHERE user_id=?",
      [user.id],
    );
    const [entries] = await c.query(
      "SELECT c.*,c.points_change points,c.carbon_kg_change carbon_kg FROM carbon_transactions c JOIN ride_orders r ON r.id=c.order_id WHERE r.user_id=? ORDER BY c.id DESC",
      [user.id],
    );
    const [attempts] = await c.query(
      "SELECT a.* FROM return_attempts a JOIN ride_orders r ON r.id=a.order_id WHERE r.user_id=? ORDER BY a.id DESC LIMIT 100",
      [user.id],
    );
    const [[summary]] = await c.query(
      "SELECT (SELECT COUNT(*) FROM bikes WHERE status<>'RETIRED') total_bikes,(SELECT COUNT(*) FROM bikes WHERE status='AVAILABLE') available_bikes,(SELECT COUNT(*) FROM ride_orders WHERE status='RUNNING') active_rides,(SELECT COUNT(*) FROM ride_orders WHERE DATE(DATE_ADD(started_at,INTERVAL 8 HOUR))=DATE(DATE_ADD(UTC_TIMESTAMP(),INTERVAL 8 HOUR))) today_rides,(SELECT COALESCE(SUM(carbon_kg_change),0) FROM carbon_transactions) carbon_kg,(SELECT COUNT(*) FROM maintenance_tickets WHERE status<>'COMPLETED') open_tickets",
    );
    await c.commit();
    return {
      zones,
      bikes,
      rides,
      payments,
      staff,
      dispatches,
      tickets,
      carbon: { ...carbon, entries },
      summary,
      attempts,
    };
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
export async function analytics(pool, filter) {
  const [zones] = await pool.query(
    "SELECT * FROM v_zone_inventory ORDER BY id",
  );
  const [rides] = await pool.query("SELECT * FROM ride_orders");
  const [snapshots] = await pool.query(
    "SELECT * FROM zone_snapshots ORDER BY captured_at",
  );
  const [bikes] = await pool.query(
    "SELECT * FROM bikes WHERE status<>'RETIRED'",
  );
  const [tickets] = await pool.query("SELECT * FROM maintenance_tickets");
  const hot = aggregateHotspots(zones, rides, snapshots, filter);
  const [savedSuggestions] = await pool.query(
    `SELECT s.*,a.name source_name,b.name target_name FROM dispatch_suggestions s
     JOIN parking_zones a ON a.id=s.source_zone_id JOIN parking_zones b ON b.id=s.target_zone_id ORDER BY s.id DESC LIMIT 100`,
  );
  const [riskAlerts] = await pool.query(
    `SELECT r.*,b.code bike_code,u.name handler_name,t.status ticket_status FROM risk_alerts r
     JOIN bikes b ON b.id=r.bike_id LEFT JOIN users u ON u.id=r.handler_id
     LEFT JOIN maintenance_tickets t ON t.id=r.maintenance_ticket_id ORDER BY r.id DESC`,
  );
  return {
    ...hot,
    suggestions: dispatchSuggestions(zones, hot.hotspots),
    risks: bikeRisks(bikes, tickets),
    risk_alerts: riskAlerts,
    saved_suggestions: savedSuggestions,
  };
}
export async function leaderboard(pool, period, metric, viewerId) {
  const [users] = await pool.query(
      "SELECT id,name,leaderboard_alias,leaderboard_visible FROM users",
    ),
    [rides] = await pool.query(
      "SELECT * FROM ride_orders WHERE status='PAID' AND ended_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 32 DAY)",
    ),
    [entries] = await pool.query(
      "SELECT * FROM carbon_transactions WHERE created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 32 DAY)",
    );
  return buildLeaderboard(
    users,
    rides,
    entries,
    period,
    metric,
    new Date(),
    viewerId,
  );
}
