import { z } from "zod";
import { AppError, actorTransaction } from "./db.mjs";

const schema = z.object({
  id: z.coerce.number().int().positive(),
  direction: z.enum(["BOTH", "FORWARD", "REVERSE"]),
  status: z.enum(["OPEN", "CLOSED", "NO_RIDE"]),
  slope_percent: z.coerce.number().min(-30).max(30),
  surface: z.enum(["SMOOTH", "AVERAGE", "ROUGH"]),
  shade_level: z.coerce.number().int().min(0).max(5),
  lighting_level: z.coerce.number().int().min(0).max(5),
  traffic_mix: z.enum(["BIKE_ONLY", "MIXED", "MOTOR_HEAVY"]),
  intersection_risk: z.coerce.number().int().min(0).max(5),
});
export function saveRoad(pool, actor, input) {
  if (actor.role !== "ADMIN")
    throw new AppError("仅管理员可维护道路", "FORBIDDEN", 403);
  const data = schema.parse(input);
  return actorTransaction(pool, actor, async (c) => {
    const [[before]] = await c.query(
      "SELECT * FROM road_edges WHERE id=? FOR UPDATE",
      [data.id],
    );
    if (!before) throw new AppError("道路不存在", "NOT_FOUND", 404);
    await c.query(
      `UPDATE road_edges SET direction=?,status=?,slope_percent=?,surface=?,shade_level=?,lighting_level=?,traffic_mix=?,intersection_risk=? WHERE id=?`,
      [
        data.direction,
        data.status,
        data.slope_percent,
        data.surface,
        data.shade_level,
        data.lighting_level,
        data.traffic_mix,
        data.intersection_risk,
        data.id,
      ],
    );
    await c.query(
      "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?)",
      [
        actor.id,
        "ROAD_UPDATE",
        "road_edges",
        data.id,
        JSON.stringify({ before, after: data }),
      ],
    );
    return { id: data.id };
  });
}
