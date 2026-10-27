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
  // A binary heap keeps route search O((V + E) log V). Stable discovery
  // order preserves deterministic choices when path costs are equal.
  const heap = [],
    costs = new Map([[fromId, 0]]),
    previous = new Map(),
    visited = new Set(),
    order = new Map([[fromId, 0]]);
  const earlier = (a, b) =>
    a.cost < b.cost || (a.cost === b.cost && a.order < b.order);
  const push = (entry) => {
    let i = heap.length;
    heap.push(entry);
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (!earlier(entry, heap[parent])) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = entry;
  };
  const pop = () => {
    const first = heap[0],
      last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (true) {
        let child = i * 2 + 1;
        if (child >= heap.length) break;
        if (child + 1 < heap.length && earlier(heap[child + 1], heap[child]))
          child++;
        if (!earlier(heap[child], last)) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  push({ id: fromId, cost: 0, order: 0 });
  let reached = false;
  while (heap.length) {
    const { id: next, cost: best } = pop();
    if (visited.has(next) || costs.get(next) !== best) continue;
    if (next === toId) {
      reached = true;
      break;
    }
    visited.add(next);
    for (const edge of graph.get(next)) {
      const candidate = best + edge.weight;
      if (
        !visited.has(edge.to) &&
        candidate < (costs.get(edge.to) ?? Infinity)
      ) {
        if (!order.has(edge.to)) order.set(edge.to, order.size);
        costs.set(edge.to, candidate);
        previous.set(edge.to, {
          id: next,
          distance: edge.distance,
          detail: edge.detail,
        });
        push({ id: edge.to, cost: candidate, order: order.get(edge.to) });
      }
    }
  }
  if (!reached) throw new Error("No route between selected zones");
  const path = [toId];
  let distance = 0,
    id = toId;
  const segments = [];
  while (id !== fromId) {
    const p = previous.get(id);
    if (!p) throw new Error("No route between selected zones");
    distance += p.distance;
    segments.push({
      from_node_id: p.id,
      to_node_id: id,
      ...p.detail,
      distance_m: p.distance,
    });
    id = p.id;
    path.push(id);
  }
  path.reverse();
  segments.reverse();
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
export function parseReportingDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)))
    throw new Error("Invalid reporting date");
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1000 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new Error("Invalid reporting date");
  return date.getTime() - OFFSET;
}
export function reportFilter(input, now) {
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
  const start = parseReportingDay(input.start),
    end = Math.min(parseReportingDay(input.end) + DAY, endNow),
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
