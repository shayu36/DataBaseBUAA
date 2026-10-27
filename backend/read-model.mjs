import { hotspotReport } from "./hotspot-report.mjs";
import { riskData } from "./risk-data.mjs";
import { readSnapshot } from "./db.mjs";
import { dispatchSuggestions } from "./dispatch-suggestions.mjs";
import { listDispatchSuggestions } from "./operations.mjs";
import { listRiskAlerts } from "./risks.mjs";
import { pageById } from "./pagination.mjs";
export async function dashboard(pool, user) {
  return readSnapshot(pool, async (c) => {
    const [result] = await c.query("CALL sp_dashboard(?,?)", [
      user.id,
      user.role,
    ]);
    const [
      zones,
      bikes,
      rides,
      payments,
      staff,
      dispatches,
      items,
      tickets,
      carbonRows,
      entries,
      attempts,
      summaryRows,
    ] = result;
    const bikesByTask = new Map();
    for (const item of items) {
      if (!bikesByTask.has(item.task_id)) bikesByTask.set(item.task_id, []);
      bikesByTask.get(item.task_id).push(item.bike_id);
    }
    for (const task of dispatches)
      task.bike_ids = bikesByTask.get(task.id) || [];
    const carbon = carbonRows[0],
      summary = summaryRows[0],
      attemptPage = pageById(attempts, "attempts"),
      entryPage = pageById(entries, "entries");
    return {
      zones,
      bikes,
      rides,
      payments,
      staff,
      dispatches,
      tickets,
      carbon: {
        ...carbon,
        entries: entryPage.entries,
        entries_next_before: entryPage.next_before,
      },
      summary,
      attempts: attemptPage.attempts,
      attempts_next_before: attemptPage.next_before,
    };
  });
}
export async function analytics(pool, filter) {
  return readSnapshot(pool, async (connection) => {
    const now = new Date();
    const { zones, report: hot } = await hotspotReport(connection, filter, now);
    const { risks } = await riskData(connection, now);
    const savedSuggestions = await listDispatchSuggestions(connection);
    const riskAlerts = await listRiskAlerts(connection);
    const suggestions = await dispatchSuggestions(
      connection,
      zones,
      hot.hotspots,
    );
    return {
      ...hot,
      suggestions,
      risks,
      risk_alerts: riskAlerts.risks,
      risk_alerts_next_before: riskAlerts.next_before,
      saved_suggestions: savedSuggestions.suggestions,
      saved_suggestions_next_before: savedSuggestions.next_before,
    };
  });
}
export async function leaderboard(pool, period, metric, viewerId) {
  const [result] = await pool.query("CALL sp_leaderboard(?,?,?)", [
    period,
    metric,
    viewerId,
  ]);
  const ranked = result[0].map((row) => ({
    ...row,
    rank: row.rank === null ? null : Number(row.rank),
    rides: Number(row.rides),
    distance_m: Number(row.distance_m),
    points: Number(row.points),
    carbon_kg: Number(row.carbon_kg),
    visible: Boolean(row.visible),
  }));
  const own = ranked.find((row) => row.user_id === Number(viewerId));
  const rows = ranked
    .filter((row) => row.visible && row.rank !== null)
    .map(({ visible, ...row }) => row);
  const me = own
    ? (({ visible, ...row }) => ({ ...row, private: !visible }))(own)
    : null;
  return {
    period,
    metric,
    rows,
    me,
    window: {
      start: result[1][0].start_time.toISOString(),
      end: result[1][0].end_time.toISOString(),
      timezone: "Asia/Shanghai",
    },
  };
}
