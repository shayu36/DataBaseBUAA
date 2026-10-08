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
    if (["CLOSED", "NO_RIDE"].includes(edge.status)) continue;
    const distance = Number(edge.distance_m),
      safety = Number(edge.safety_cost),
      comfort = Number(edge.comfort_cost);
    if (
      !graph.has(edge.from_node_id) ||
      !graph.has(edge.to_node_id) ||
      ![distance, safety, comfort].every((n) => Number.isFinite(n) && n >= 0)
    )
      throw new Error("Invalid road edge");
    const traffic =
        edge.traffic_mix === "MOTOR_HEAVY"
          ? 0.8
          : edge.traffic_mix === "MIXED"
            ? 0.35
            : 0,
      surface =
        edge.surface === "ROUGH" ? 0.75 : edge.surface === "AVERAGE" ? 0.3 : 0,
      safetyPenalty =
        safety +
        number(edge.intersection_risk) * 0.18 +
        traffic +
        Math.max(0, 5 - number(edge.lighting_level ?? 5)) * 0.12,
      comfortPenalty =
        comfort +
        surface +
        Math.abs(Number(edge.slope_percent || 0)) * 0.04 +
        Math.max(0, 5 - number(edge.shade_level ?? 5)) * 0.08,
      weight =
        distance *
        (mode === "safe"
          ? 1 + safetyPenalty
          : mode === "comfortable"
            ? 1 + comfortPenalty
            : 1),
      detail = { ...edge, distance, safetyPenalty, comfortPenalty };
    if (!Number.isFinite(weight)) throw new Error("Invalid route weight");
    if (edge.direction !== "REVERSE")
      graph
        .get(edge.from_node_id)
        .push({ to: edge.to_node_id, distance, weight, detail });
    if (edge.direction !== "FORWARD")
      graph
        .get(edge.to_node_id)
        .push({ to: edge.from_node_id, distance, weight, detail });
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
        previous.set(edge.to, {
          id: next,
          distance: edge.distance,
          detail: edge.detail,
        });
      }
  }
  const path = [toId];
  let distance = 0,
    id = toId;
  const segments = [];
  while (id !== fromId) {
    const p = previous.get(id);
    if (!p) throw new Error("No route between selected zones");
    distance += p.distance;
    segments.unshift({
      from_node_id: p.id,
      to_node_id: id,
      ...p.detail,
      distance_m: p.distance,
    });
    id = p.id;
    path.unshift(id);
  }
  if (!Number.isFinite(distance)) throw new Error("Invalid route distance");
  const attribute_totals = segments.reduce(
    (a, s) => ({
      intersection_risk: a.intersection_risk + number(s.intersection_risk),
      motor_heavy_edges:
        a.motor_heavy_edges + (s.traffic_mix === "MOTOR_HEAVY" ? 1 : 0),
      rough_edges: a.rough_edges + (s.surface === "ROUGH" ? 1 : 0),
      shaded_edges: a.shaded_edges + (number(s.shade_level) >= 4 ? 1 : 0),
    }),
    {
      intersection_risk: 0,
      motor_heavy_edges: 0,
      rough_edges: 0,
      shaded_edges: 0,
    },
  );
  const explanation =
    mode === "safe"
      ? `避开封闭及禁骑路段，综合机动车混行、交叉口和照明模拟属性；途经 ${attribute_totals.motor_heavy_edges} 条机动车较多道路`
      : mode === "comfortable"
        ? `避开封闭及禁骑路段，综合路面、坡度和遮阴模拟属性；途经 ${attribute_totals.shaded_edges} 条高遮阴道路`
        : "避开封闭及禁骑路段，以可通行道路长度计算最短路线";
  return {
    path,
    distance_m: round(distance),
    duration_minutes: round(distance / 200),
    mode,
    segments,
    attribute_totals,
    explanation,
    attribute_source: "SIMULATED_COURSE_DATA",
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
        desired_inventory: target.desired,
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
        reason_details: reasons.map((message) => ({
          rule: message.includes("同类型")
            ? "REPEAT_FAULT"
            : message.includes("维修")
              ? "SERVICE_GAP"
              : message.includes("报修")
                ? "RECENT_FAULTS"
                : "NONE",
          message,
        })),
      };
    })
    .sort((a, b) => b.score - a.score || a.bike_id - b.bike_id);
}
function reportFilter(input, now) {
  const endNow = clock(now);
  if (typeof input === "number" || input == null) {
    const days = Number(input ?? 7);
    if (![7, 30].includes(days)) throw new Error("Invalid reporting days");
    return {
      start: endNow - days * DAY,
      end: endNow,
      dayType: "ALL",
      startHour: 0,
      endHour: 24,
      zoneId: null,
      preset: String(days),
      timezone: "Asia/Shanghai",
    };
  }
  const parseDay = (value, end = false) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)))
      throw new Error("Invalid reporting date");
    const [year, month, day] = String(value).split("-").map(Number);
    return Date.UTC(year, month - 1, day + (end ? 1 : 0)) - OFFSET;
  };
  const start = parseDay(input.start),
    end = Math.min(parseDay(input.end, true), endNow),
    startHour = Number(input.startHour ?? 0),
    endHour = Number(input.endHour ?? 24),
    dayType = input.dayType || "ALL",
    zoneId = input.zoneId == null ? null : Number(input.zoneId);
  if (
    end <= start ||
    end - start > 31 * DAY ||
    !["ALL", "WEEKDAY", "WEEKEND"].includes(dayType) ||
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    endHour > 24 ||
    startHour >= endHour ||
    (zoneId != null && (!Number.isInteger(zoneId) || zoneId <= 0))
  )
    throw new Error("Invalid reporting range");
  return {
    start,
    end,
    dayType,
    startHour,
    endHour,
    zoneId,
    preset: "custom",
    timezone: "Asia/Shanghai",
  };
}

export function aggregateHotspots(
  zones,
  rides,
  snapshots,
  filter = 7,
  now = new Date(),
) {
  const normalized = reportFilter(filter, now),
    { start, end } = normalized,
    included = (time) => {
      const t = timestamp(time);
      if (!Number.isFinite(t) || t < start || t > end) return false;
      const local = new Date(t + OFFSET),
        weekday = local.getUTCDay(),
        hour = local.getUTCHours();
      return (
        hour >= normalized.startHour &&
        hour < normalized.endHour &&
        (normalized.dayType === "ALL" ||
          (normalized.dayType === "WEEKDAY" && weekday >= 1 && weekday <= 5) ||
          (normalized.dayType === "WEEKEND" &&
            (weekday === 0 || weekday === 6)))
      );
    };
  const selectedZones = normalized.zoneId
    ? zones.filter((z) => z.id === normalized.zoneId)
    : zones;
  const hotspots = selectedZones.map((z) => ({
    zone_id: z.id,
    name: z.name,
    available: number(z.available),
    occupied: number(z.occupied),
    capacity: number(z.capacity),
    reserved: number(z.reserved),
    borrow_count: 0,
    return_count: 0,
    net_flow: 0,
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
    if (!zone || !included(time)) return;
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
    if (included(s.captured_at)) snapshot_count++;
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
      if (normalized.preset === "custom" && !included(a.captured_at)) continue;
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
    h.net_flow = h.return_count - h.borrow_count;
  }
  const inventory_series = [...grouped.entries()].flatMap(([zoneId, list]) =>
    list
      .filter((s) => included(s.captured_at))
      .map((s) => ({
        zone_id: zoneId,
        captured_at: s.captured_at,
        available: number(s.available),
        occupied: number(s.occupied),
        capacity: number(s.capacity),
      })),
  );
  const possibleMinutes =
      selectedZones.length *
      ((end - start) / DAY) *
      (normalized.endHour - normalized.startHour) *
      60,
    perZonePossible = selectedZones.length
      ? possibleMinutes / selectedZones.length
      : 0,
    covered = hotspots.reduce((sum, h) => sum + h.coverage_minutes, 0);
  for (const h of hotspots)
    h.coverage_ratio = perZonePossible
      ? round(h.coverage_minutes / perZonePossible)
      : 0;
  return {
    hotspots,
    hourly,
    weekday,
    inventory_series,
    snapshot_count,
    coverage_ratio: possibleMinutes ? round(covered / possibleMinutes) : 0,
    filter: {
      ...normalized,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    },
    methodology: {
      snapshot_gap_minutes: 5,
      shortage_threshold: "available <= 20% capacity",
      simulation: true,
    },
  };
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
