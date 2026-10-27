import { hotspotReport } from "./hotspot-report.mjs";
import { riskData } from "./risk-data.mjs";
import { readSnapshot } from "./db.mjs";
import { dispatchSuggestions } from "./dispatch-suggestions.mjs";
import { listDispatchSuggestions } from "./operations.mjs";
import { listRiskAlerts } from "./risks.mjs";
import { pageById } from "./pagination.mjs";
import { normalizeDispatches } from "./history.mjs";
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
      tickets,
      carbonRows,
      entries,
      attempts,
      summaryRows,
      actionableRides,
      carbonRuleRows,
    ] = result;
    normalizeDispatches(dispatches);
    const activeDispatches = dispatches.filter((row) =>
      ["PENDING", "IN_PROGRESS"].includes(row.status),
    );
    const pastDispatches = pageById(
      dispatches.filter((row) =>
        ["COMPLETED", "CANCELLED"].includes(row.status),
      ),
      "dispatches",
    );
    const activeTickets = tickets.filter((row) => row.status !== "COMPLETED");
    const pastTickets = pageById(
      tickets.filter((row) => row.status === "COMPLETED"),
      "tickets",
    );
    const carbon = carbonRows[0],
      summary = summaryRows[0],
      attemptPage = pageById(attempts, "attempts"),
      entryPage = pageById(entries, "entries"),
      ridePage = pageById(rides, "rides"),
      paymentPage = pageById(payments, "payments");
    return {
      zones,
      bikes,
      rides: ridePage.rides,
      rides_next_before: ridePage.next_before,
      actionable_rides: actionableRides,
      payments: paymentPage.payments,
      payments_next_before: paymentPage.next_before,
      staff,
      dispatches: [...activeDispatches, ...pastDispatches.dispatches],
      dispatches_next_before: pastDispatches.next_before,
      tickets: [...activeTickets, ...pastTickets.tickets],
      tickets_next_before: pastTickets.next_before,
      carbon: {
        ...carbon,
        rule: carbonRuleRows[0],
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
