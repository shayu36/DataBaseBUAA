import { reportFilter } from "./analytics.mjs";

const round = (value) => Math.round(value * 100) / 100;

export async function hotspotReport(db, filter, now) {
  const normalized = reportFilter(filter, now);
  const [result] = await db.query("CALL sp_hotspot_report(?,?,?,?,?,?)", [
    new Date(normalized.start),
    new Date(normalized.end),
    normalized.dayType,
    normalized.startHour,
    normalized.endHour,
    normalized.zoneId,
  ]);
  const [zones, events, intervals, series, possibleRows] = result;
  const hotspots = zones.map((z) => ({
    zone_id: z.id,
    name: z.name,
    available: Number(z.available),
    occupied: Number(z.occupied),
    capacity: Number(z.capacity),
    reserved: Number(z.reserved),
    borrow_count: 0,
    return_count: 0,
    net_flow: 0,
    peak_hour: null,
    shortage_minutes: 0,
    full_minutes: 0,
    coverage_minutes: 0,
  }));
  const byZone = new Map(hotspots.map((h) => [h.zone_id, h]));
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    borrow_count: 0,
    return_count: 0,
  }));
  const weekday = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    borrow_count: 0,
    return_count: 0,
  }));
  const peaks = new Map();
  for (const event of events) {
    const zone = byZone.get(event.zone_id);
    const borrow = Number(event.borrow_count),
      returns = Number(event.return_count);
    zone.borrow_count += borrow;
    zone.return_count += returns;
    hourly[event.hour].borrow_count += borrow;
    hourly[event.hour].return_count += returns;
    weekday[event.weekday].borrow_count += borrow;
    weekday[event.weekday].return_count += returns;
    if (borrow) {
      const counts = peaks.get(event.zone_id) || Array(24).fill(0);
      counts[event.hour] += borrow;
      peaks.set(event.zone_id, counts);
    }
  }
  for (const interval of intervals) {
    const zone = byZone.get(interval.zone_id);
    zone.coverage_minutes = Number(interval.coverage_minutes);
    zone.shortage_minutes = Number(interval.shortage_minutes);
    zone.full_minutes = Number(interval.full_minutes);
  }
  const perZonePossible = Number(possibleRows[0].possible_minutes);
  let covered = 0;
  for (const zone of hotspots) {
    const counts = peaks.get(zone.zone_id);
    if (counts) zone.peak_hour = counts.indexOf(Math.max(...counts));
    zone.net_flow = zone.return_count - zone.borrow_count;
    zone.coverage_ratio = perZonePossible
      ? round(zone.coverage_minutes / perZonePossible)
      : 0;
    covered += zone.coverage_minutes;
  }
  const possible = perZonePossible * zones.length;
  return {
    zones,
    report: {
      hotspots,
      hourly,
      weekday,
      inventory_series: series,
      snapshot_count: Number(possibleRows[0].snapshot_count),
      coverage_ratio: possible ? round(covered / possible) : 0,
      filter: {
        ...normalized,
        start: new Date(normalized.start).toISOString(),
        end: new Date(normalized.end).toISOString(),
      },
      methodology: {
        snapshot_gap_minutes: 5,
        shortage_threshold: "available <= 20% capacity",
        simulation: true,
      },
    },
  };
}
