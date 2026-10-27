// MySQL aggregates recent tickets and last service dates; this formats rule explanations.
export async function riskData(connection, now) {
  const [result] = await connection.query("CALL sp_risk_inputs(?)", [now]);
  const [rows] = result;
  const byBike = new Map();
  for (const row of rows) {
    if (!byBike.has(row.bike_id))
      byBike.set(row.bike_id, { bike: row, repeats: [] });
    if (row.repeat_reason)
      byBike.get(row.bike_id).repeats.push(row.repeat_reason);
  }
  const risks = [...byBike.values()].map(({ bike, repeats }) => {
    const details = [];
    if (bike.recent_reason)
      details.push({ rule: "RECENT_FAULTS", message: bike.recent_reason });
    for (const message of repeats)
      details.push({ rule: "REPEAT_FAULT", message });
    if (bike.service_reason)
      details.push({ rule: "SERVICE_GAP", message: bike.service_reason });
    if (bike.short_ride_reason)
      details.push({ rule: "SHORT_RIDE", message: bike.short_ride_reason });
    if (!details.length)
      details.push({ rule: "NONE", message: "近期无触发规则的风险因素" });
    return {
      bike_id: bike.bike_id,
      code: bike.code,
      score: Number(bike.score),
      level: bike.level,
      reasons: details.map((detail) => detail.message),
      reason_details: details,
    };
  });
  return { risks, evaluated: risks.length };
}
