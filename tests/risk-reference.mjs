// Independent reference for comparing SQL risk inputs.
const DAY = 86400000;
const timestamp = (value) => (value == null ? NaN : new Date(value).getTime());
function clock(now) {
  const value = timestamp(now);
  if (!Number.isFinite(value)) throw new Error("Invalid date");
  return value;
}
export function bikeRisks(bikes, tickets, now = new Date()) {
  const end = clock(now);
  const ticketsByBike = new Map();
  for (const ticket of tickets) {
    const group = ticketsByBike.get(ticket.bike_id) || [];
    group.push(ticket);
    ticketsByBike.set(ticket.bike_id, group);
  }
  return bikes
    .map((b) => {
      const history = ticketsByBike.get(b.id) || [];
      const reasons = [],
        types = new Map();
      let score = 0,
        recentCount = 0,
        last = timestamp(b.last_service_at);
      if (!Number.isFinite(last) || last > end) last = -Infinity;
      for (const ticket of history) {
        const created = timestamp(ticket.created_at);
        if (created >= end - 30 * DAY && created <= end) {
          recentCount++;
          types.set(ticket.fault_type, (types.get(ticket.fault_type) || 0) + 1);
        }
        if (ticket.status === "COMPLETED") {
          const completed = timestamp(ticket.completed_at);
          if (
            Number.isFinite(completed) &&
            completed <= end &&
            completed > last
          )
            last = completed;
        }
      }
      if (recentCount) {
        score += Math.min(40, recentCount * 10);
        reasons.push(
          `近30天报修 ${recentCount} 次（+${Math.min(40, recentCount * 10)}）`,
        );
      }
      for (const [type, count] of types)
        if (count >= 2) {
          score += 20;
          reasons.push(`${type} 同类型故障复发 ${count} 次（+20）`);
        }
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
