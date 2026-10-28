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
  const [zones, demand] = result;
  return { zones, demand, filter: window };
}

export async function hotspotReport(db, filter, now) {
  const { result, window } = await hotspotInputs(db, filter, now, true);
  const [zones, hotspots, hourly, weekday, summary, series] = result;
  return {
    zones,
    report: {
      hotspots,
      hourly,
      weekday,
      inventory_series: series,
      snapshot_count: Number(summary[0].snapshot_count),
      coverage_ratio: Number(summary[0].coverage_ratio),
      filter: window,
      methodology: {
        snapshot_gap_minutes: 5,
        shortage_threshold: "available <= 20% capacity",
        simulation: true,
      },
    },
  };
}
