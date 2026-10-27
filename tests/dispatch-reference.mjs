// Independent reference for checking SQL dispatch allocations.
const number = (value) =>
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
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
        Math.ceil((capacity * 8) / 10),
        Math.max(
          Math.ceil((capacity * 4) / 10),
          Math.ceil((capacity * 4 + net * 2) / 10),
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
