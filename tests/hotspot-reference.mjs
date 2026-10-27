// Independent reference for comparing SQL hotspot results.
import { reportFilter } from "../backend/analytics.mjs";
const DAY = 86400000,
  OFFSET = 8 * 3600000;
const number = (value) =>
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const timestamp = (value) => (value == null ? NaN : new Date(value).getTime());
const round = (value) => Math.round(value * 100) / 100;
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
      if (!Number.isFinite(t) || t < start || t >= end) return false;
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
  const selectedMinutes = (from, to) => {
    let minutes = 0;
    let day = Math.floor((from + OFFSET) / DAY) * DAY - OFFSET;
    while (day < to) {
      const weekday = new Date(day + OFFSET).getUTCDay();
      if (
        normalized.dayType === "ALL" ||
        (normalized.dayType === "WEEKDAY" && weekday >= 1 && weekday <= 5) ||
        (normalized.dayType === "WEEKEND" && (weekday === 0 || weekday === 6))
      ) {
        minutes +=
          Math.max(
            0,
            Math.min(to, day + normalized.endHour * 3600000) -
              Math.max(from, day + normalized.startHour * 3600000),
          ) / 60000;
      }
      day += DAY;
    }
    return minutes;
  };
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
      const minutes = selectedMinutes(Math.max(a.t, start), Math.min(b.t, end));
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
  const inventory_series = [...grouped.entries()].flatMap(([zoneId, list]) => {
    let previous = null,
      segment = 0;
    return list
      .filter((s) => included(s.captured_at))
      .map((s) => {
        if (previous === null || s.t - previous > 300000) segment++;
        previous = s.t;
        return {
          zone_id: zoneId,
          captured_at: s.captured_at,
          available: number(s.available),
          occupied: number(s.occupied),
          capacity: number(s.capacity),
          segment_id: segment,
        };
      });
  });
  const perZonePossible = selectedMinutes(start, end),
    possibleMinutes = selectedZones.length * perZonePossible,
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
