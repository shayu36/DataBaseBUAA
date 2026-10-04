// Pure, deterministic classroom analytics; no learned prediction or external services.
const DAY = 86400000;
const OFFSET = 8 * 3600000;
const number = (value) =>
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const timestamp = (value) => (value == null ? NaN : new Date(value).getTime());
const round = (value) => Math.round(value * 100) / 100;
function clock(now) {
  const n = timestamp(now);
  if (!Number.isFinite(n)) throw new Error("Invalid date");
  return n;
}
export function findRoute(nodes, edges, fromId, toId, mode = "shortest") {
  if (!["shortest", "safe", "comfortable"].includes(mode))
    throw new Error("Invalid route mode");
  const graph = new Map(nodes.map((n) => [n.id, []]));
  if (!graph.has(fromId) || !graph.has(toId))
    throw new Error("Unknown road node");
  for (const edge of edges) {
    const distance = Number(edge.distance_m),
      safety = Number(edge.safety_cost),
      comfort = Number(edge.comfort_cost);
    if (
      !graph.has(edge.from_node_id) ||
      !graph.has(edge.to_node_id) ||
      ![distance, safety, comfort].every((n) => Number.isFinite(n) && n >= 0)
    )
      throw new Error("Invalid road edge");
    const weight =
      distance *
      (mode === "safe" ? 1 + safety : mode === "comfortable" ? 1 + comfort : 1);
    if (!Number.isFinite(weight)) throw new Error("Invalid route weight");
    graph
      .get(edge.from_node_id)
      .push({ to: edge.to_node_id, distance, weight });
    graph
      .get(edge.to_node_id)
      .push({ to: edge.from_node_id, distance, weight });
  }
  const costs = new Map([[fromId, 0]]),
    previous = new Map(),
    visited = new Set();
  while (true) {
    let next,
      best = Infinity;
    for (const [id, cost] of costs)
      if (!visited.has(id) && cost < best) {
        next = id;
        best = cost;
      }
    if (next === undefined) throw new Error("No route between selected zones");
    if (next === toId) break;
    visited.add(next);
    for (const edge of graph.get(next))
      if (
        !visited.has(edge.to) &&
        best + edge.weight < (costs.get(edge.to) ?? Infinity)
      ) {
        costs.set(edge.to, best + edge.weight);
        previous.set(edge.to, { id: next, distance: edge.distance });
      }
  }
  const path = [toId];
  let distance = 0,
    id = toId;
  while (id !== fromId) {
    const p = previous.get(id);
    distance += p.distance;
    id = p.id;
    path.unshift(id);
  }
  if (!Number.isFinite(distance)) throw new Error("Invalid route distance");
  return {
    path,
    distance_m: round(distance),
    duration_minutes: round(distance / 200),
    mode,
  };
}
export function dispatchSuggestions(zones, demand = []) {
  const history = new Map(demand.map((d) => [d.zone_id, d]));
  const states = zones
    .filter((z) => !z.status || z.status === "ACTIVE")
    .map((z) => {
      const capacity = Math.floor(number(z.capacity)),
        available = Math.floor(number(z.available));
      const d = history.get(z.id);
      // Historical net borrowing raises target inventory, capped at 80% of capacity.
      const net = number(d?.borrow_count) - number(d?.return_count);
      const desired = Math.min(
        Math.ceil(capacity * 0.8),
        Math.max(
          Math.ceil(capacity * 0.4),
          Math.ceil(capacity * 0.4 + net * 0.2),
        ),
      );
      return {
        ...z,
        available,
        desired,
        free: Math.max(
          0,
          Math.floor(capacity - number(z.occupied) - number(z.reserved)),
        ),
        supply: Math.max(0, available - desired),
        need: Math.max(0, desired - available),
      };
    });
  const sources = states
      .filter((s) => s.supply > 0)
      .sort((a, b) => b.supply - a.supply || a.id - b.id),
    targets = states
      .filter((s) => s.need > 0 && s.free > 0)
      .sort((a, b) => b.need - a.need || a.id - b.id),
    result = [];
  for (const target of targets)
    for (const source of sources) {
      const quantity = Math.min(source.supply, target.need, target.free);
      if (quantity <= 0 || source.id === target.id) continue;
      result.push({
        source_zone_id: source.id,
        target_zone_id: target.id,
        source_name: source.name,
        target_name: target.name,
        quantity,
        reason: `目标库存 ${target.available}，建议保有 ${target.desired}；按容量、预留车位及历史净借车需求估算`,
      });
      source.supply -= quantity;
      target.need -= quantity;
      target.free -= quantity;
    }
  return result;
}
export function bikeRisks(bikes, tickets, now = new Date()) {
  const end = clock(now);
  return bikes
    .map((b) => {
      const recent = tickets.filter(
        (t) =>
          t.bike_id === b.id &&
          timestamp(t.created_at) >= end - 30 * DAY &&
          timestamp(t.created_at) <= end,
      );
      const reasons = [];
      let score = 0;
      if (recent.length) {
        score += Math.min(40, recent.length * 10);
        reasons.push(
          `近30天报修 ${recent.length} 次（+${Math.min(40, recent.length * 10)}）`,
        );
      }
      const types = new Map();
      for (const t of recent)
        types.set(t.fault_type, (types.get(t.fault_type) || 0) + 1);
      for (const [type, count] of types)
        if (count >= 2) {
          score += 20;
          reasons.push(`${type} 同类型故障复发 ${count} 次（+20）`);
        }
      const serviceDates = tickets
        .filter((t) => t.bike_id === b.id && t.status === "COMPLETED")
        .map((t) => timestamp(t.completed_at));
      const last = Math.max(
        ...[timestamp(b.last_service_at), ...serviceDates].filter(
          (t) => Number.isFinite(t) && t <= end,
        ),
      );
      if (!Number.isFinite(last)) {
        score += 20;
        reasons.push("无有效维修记录（+20）");
      } else {
        const days = Math.floor((end - last) / DAY);
        if (days >= 90) {
          score += 30;
          reasons.push(`距最近维修 ${days} 天（+30）`);
        } else if (days >= 30) {
          score += 10;
          reasons.push(`距最近维修 ${days} 天（+10）`);
        }
      }
      score = Math.min(100, score);
      if (!reasons.length) reasons.push("近期无触发规则的风险因素");
      return {
        bike_id: b.id,
        code: b.code,
        score,
        level: score >= 60 ? "HIGH" : score >= 30 ? "MEDIUM" : "LOW",
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score || a.bike_id - b.bike_id);
}
export function aggregateHotspots(
  zones,
  rides,
  snapshots,
  days = 7,
  now = new Date(),
) {
  if (![7, 30].includes(Number(days)))
    throw new Error("Invalid reporting days");
  const end = clock(now),
    start = end - Number(days) * DAY;
  const hotspots = zones.map((z) => ({
    zone_id: z.id,
    name: z.name,
    borrow_count: 0,
    return_count: 0,
    peak_hour: null,
    shortage_minutes: 0,
    full_minutes: 0,
    coverage_minutes: 0,
  }));
  const byZone = new Map(hotspots.map((h) => [h.zone_id, h])),
    hourly = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      borrow_count: 0,
      return_count: 0,
    })),
    weekday = Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      borrow_count: 0,
      return_count: 0,
    })),
    peaks = new Map();
  function event(zoneId, time, field) {
    const t = timestamp(time),
      zone = byZone.get(zoneId);
    if (!zone || !Number.isFinite(t) || t < start || t > end) return;
    const date = new Date(t + OFFSET),
      hour = date.getUTCHours();
    zone[field]++;
    hourly[hour][field]++;
    weekday[date.getUTCDay()][field]++;
    if (field === "borrow_count") {
      const counts = peaks.get(zoneId) || Array(24).fill(0);
      counts[hour]++;
      peaks.set(zoneId, counts);
    }
  }
  for (const ride of rides) {
    event(ride.start_zone_id, ride.started_at, "borrow_count");
    event(ride.end_zone_id, ride.ended_at, "return_count");
  }
  let snapshot_count = 0;
  const grouped = new Map();
  for (const s of snapshots) {
    const t = timestamp(s.captured_at);
    if (!byZone.has(s.zone_id) || !Number.isFinite(t) || t > end) continue;
    if (t >= start) snapshot_count++;
    const list = grouped.get(s.zone_id) || [];
    list.push({ ...s, t });
    grouped.set(s.zone_id, list);
  }
  for (const [zoneId, list] of grouped) {
    list.sort((a, b) => a.t - b.t);
    const h = byZone.get(zoneId);
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i],
        b = list[i + 1],
        gap = b.t - a.t;
      if (gap <= 0 || gap > 300000) continue;
      if (
        ![a.capacity, a.available, a.occupied].every(
          (v) => v != null && Number.isFinite(Number(v)) && Number(v) >= 0,
        ) ||
        Number(a.capacity) <= 0
      )
        continue;
      const minutes =
        Math.max(0, Math.min(b.t, end) - Math.max(a.t, start)) / 60000;
      h.coverage_minutes += minutes;
      if (Number(a.available) <= Number(a.capacity) * 0.2)
        h.shortage_minutes += minutes;
      if (Number(a.occupied) >= Number(a.capacity)) h.full_minutes += minutes;
    }
  }
  for (const h of hotspots) {
    const p = peaks.get(h.zone_id);
    if (p) h.peak_hour = p.indexOf(Math.max(...p));
    for (const key of ["coverage_minutes", "shortage_minutes", "full_minutes"])
      h[key] = round(h[key]);
  }
  return { hotspots, hourly, weekday, snapshot_count };
}
export function buildLeaderboard(
  users,
  rides,
  entries,
  period = "week",
  metric = "points",
  now = new Date(),
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
    ledger = new Map();
  for (const e of entries)
    if (!ledger.has(e.order_id)) ledger.set(e.order_id, e);
  const totals = new Map(),
    seen = new Set();
  for (const r of rides) {
    const ended = timestamp(r.ended_at);
    if (
      r.status !== "PAID" ||
      !Number.isFinite(ended) ||
      ended < start ||
      ended > end ||
      !people.has(r.user_id) ||
      seen.has(r.id)
    )
      continue;
    seen.add(r.id);
    const u = people.get(r.user_id),
      chars = Array.from(String(u.name || "同学"));
    const row = totals.get(u.id) || {
      rank: 0,
      user_id: u.id,
      name: chars[0] + "**",
      rides: 0,
      distance_m: 0,
      points: 0,
      carbon_kg: 0,
    };
    row.rides++;
    row.distance_m += number(r.distance_m);
    const entry = ledger.get(r.id);
    row.points += number(entry?.points);
    row.carbon_kg += number(entry?.carbon_kg);
    totals.set(u.id, row);
  }
  const field = metric === "distance" ? "distance_m" : metric;
  const rows = [...totals.values()].sort(
    (a, b) => b[field] - a[field] || a.user_id - b.user_id,
  );
  rows.forEach((r, i) => {
    r.rank = i + 1;
    r.distance_m = round(r.distance_m);
    r.carbon_kg = Math.round(r.carbon_kg * 1000000) / 1000000;
  });
  return { period, metric, rows };
}
