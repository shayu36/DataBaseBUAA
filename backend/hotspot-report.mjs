import { reportFilter } from "./analytics.mjs";

async function hotspotInputs(db, filter, now, details) {
  const normalized = reportFilter(filter, now);
  const [result] = await db.query("CALL sp_hotspot_report(?,?,?,?,?,?,?,?)", [
    new Date(normalized.start),
    new Date(normalized.end),
    normalized.dayType,
    normalized.startHour,
    normalized.endHour,
    normalized.zoneId,
    details,
    new Date(now),
  ]);
  const window = {
    ...normalized,
    start: new Date(normalized.start).toISOString(),
    end: new Date(normalized.end).toISOString(),
  };
  return { result, window };
}

export async function hotspotDemand(db, filter, now) {
  const { result, window } = await hotspotInputs(db, filter, now, false);
  const [zones, events] = result;
  const byZone = new Map(events.map((event) => [event.zone_id, event]));
  const demand = zones.map((zone) => ({
    zone_id: zone.id,
    borrow_count: Number(byZone.get(zone.id)?.borrow_count ?? 0),
    return_count: Number(byZone.get(zone.id)?.return_count ?? 0),
  }));
  return { zones, demand, filter: window };
}

export async function hotspotReport(db, filter, now) {
  const { result, window } = await hotspotInputs(db, filter, now, true);
  const [zones, events, intervals, series] = result;
  const zoneEvents = new Map(),
    hourly = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      borrow_count: 0,
      return_count: 0,
    })),
    weekday = Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      borrow_count: 0,
      return_count: 0,
    }));
  for (const event of events) {
    if (event.kind === "ZONE") zoneEvents.set(event.zone_id, event);
    else if (event.kind === "HOUR")
      hourly[event.hour] = {
        hour: event.hour,
        borrow_count: Number(event.borrow_count),
        return_count: Number(event.return_count),
      };
    else if (event.kind === "WEEKDAY")
      weekday[event.weekday] = {
        weekday: event.weekday,
        borrow_count: Number(event.borrow_count),
        return_count: Number(event.return_count),
      };
  }
  const byZone = new Map(intervals.map((row) => [row.zone_id, row]));
  const hotspots = zones.map((zone) => {
    const event = zoneEvents.get(zone.id),
      interval = byZone.get(zone.id);
    return {
      zone_id: zone.id,
      name: zone.name,
      available: Number(zone.available),
      occupied: Number(zone.occupied),
      capacity: Number(zone.capacity),
      reserved: Number(zone.reserved),
      borrow_count: Number(event?.borrow_count ?? 0),
      return_count: Number(event?.return_count ?? 0),
      net_flow: Number(event?.net_flow ?? 0),
      peak_hour: event?.peak_hour ?? null,
      shortage_minutes: Number(interval?.shortage_minutes ?? 0),
      full_minutes: Number(interval?.full_minutes ?? 0),
      coverage_minutes: Number(interval?.coverage_minutes ?? 0),
      coverage_ratio: Number(interval?.coverage_ratio ?? 0),
    };
  });
  return {
    zones,
    report: {
      hotspots,
      hourly,
      weekday,
      inventory_series: series,
      snapshot_count: Number(intervals[0]?.snapshot_count ?? 0),
      coverage_ratio: Number(intervals[0]?.total_coverage_ratio ?? 0),
      filter: window,
      methodology: {
        snapshot_gap_minutes: 5,
        shortage_threshold: "available <= 20% capacity",
        simulation: true,
      },
    },
  };
}
