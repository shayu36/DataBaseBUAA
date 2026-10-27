// MySQL aggregates recent tickets and last service dates; this formats rule explanations.
export async function riskData(connection, now) {
  const [result] = await connection.query("CALL sp_risk_inputs(?)", [now]);
  const [bikes, faults] = result;
  const faultTypes = new Map();
  for (const fault of faults) {
    const group = faultTypes.get(fault.bike_id) || [];
    group.push(fault);
    faultTypes.set(fault.bike_id, group);
  }
  const risks = bikes.map((bike) => {
    const details = [];
    if (bike.recent_reason)
      details.push({ rule: "RECENT_FAULTS", message: bike.recent_reason });
    for (const fault of faultTypes.get(bike.bike_id) || [])
      details.push({ rule: "REPEAT_FAULT", message: fault.message });
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
  return { risks, evaluated: bikes.length };
}
