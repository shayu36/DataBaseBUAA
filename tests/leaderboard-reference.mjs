// Independent reference for comparing SQL leaderboard results.
const DAY = 86400000,
  OFFSET = 8 * 3600000;
const number = (value) =>
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const timestamp = (value) => (value == null ? NaN : new Date(value).getTime());
const round = (value) => Math.round(value * 100) / 100;
function clock(now) {
  const value = timestamp(now);
  if (!Number.isFinite(value)) throw new Error("Invalid date");
  return value;
}
export function buildLeaderboard(
  users,
  rides,
  entries,
  period = "week",
  metric = "points",
  now = new Date(),
  viewerId = null,
) {
  if (
    !["week", "month"].includes(period) ||
    !["points", "distance", "rides"].includes(metric)
  )
    throw new Error("Invalid leaderboard options");
  const end = clock(now),
    local = new Date(end + OFFSET);
  let start =
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      period === "month" ? 1 : local.getUTCDate(),
    ) - OFFSET;
  if (period === "week") start -= ((local.getUTCDay() + 6) % 7) * DAY;
  const people = new Map(users.map((u) => [u.id, u])),
    orders = new Map(rides.map((r) => [r.id, r])),
    totals = new Map(),
    seen = new Set();
  const rowFor = (userId) => {
    const u = people.get(userId);
    if (!u) return null;
    const chars = Array.from(String(u.name || "同学"));
    const row = totals.get(u.id) || {
      rank: 0,
      user_id: u.id,
      name: u.leaderboard_alias || chars[0] + "**",
      visible: u.leaderboard_visible == null || Boolean(u.leaderboard_visible),
      rides: 0,
      distance_m: 0,
      points: 0,
      carbon_kg: 0,
    };
    totals.set(u.id, row);
    return row;
  };
  for (const r of rides) {
    const ended = timestamp(r.ended_at);
    if (
      r.status !== "PAID" ||
      !Number.isFinite(ended) ||
      ended < start ||
      ended > end ||
      !people.has(r.user_id) ||
      (r.qualification_status && r.qualification_status !== "VALID") ||
      seen.has(r.id)
    )
      continue;
    seen.add(r.id);
    const row = rowFor(r.user_id);
    row.rides++;
    row.distance_m += number(r.distance_m);
  }
  for (const entry of entries) {
    const order = orders.get(entry.order_id);
    if (
      !order ||
      order.status !== "PAID" ||
      (order.qualification_status && order.qualification_status !== "VALID")
    )
      continue;
    const when = timestamp(entry.created_at ?? order.ended_at);
    if (!Number.isFinite(when) || when < start || when > end) continue;
    const row = rowFor(order.user_id);
    if (!row) continue;
    row.points += Number(entry.points_change ?? entry.points ?? 0);
    row.carbon_kg += Number(entry.carbon_kg_change ?? entry.carbon_kg ?? 0);
  }
  const field = metric === "distance" ? "distance_m" : metric;
  const ranked = [...totals.values()].sort(
    (a, b) => b[field] - a[field] || a.user_id - b.user_id,
  );
  ranked.forEach((r, i) => {
    r.rank =
      i > 0 && ranked[i - 1][field] === r[field] ? ranked[i - 1].rank : i + 1;
    r.distance_m = round(r.distance_m);
    r.carbon_kg = Math.round(r.carbon_kg * 1000000) / 1000000;
  });
  const me = ranked.find((r) => r.user_id === Number(viewerId)) || null,
    rows = ranked.filter((r) => r.visible).map(({ visible, ...r }) => r);
  return {
    period,
    metric,
    rows,
    me: me ? (({ visible, ...r }) => ({ ...r, private: !visible }))(me) : null,
    window: {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      timezone: "Asia/Shanghai",
    },
  };
}
