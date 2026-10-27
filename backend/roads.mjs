import { z } from "zod";
import { AppError, actorTransaction, callProcedure } from "./db.mjs";

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
  return actorTransaction(pool, actor, (connection) =>
    callProcedure(
      connection,
      "CALL sp_save_road(?,?)",
      [actor.id, JSON.stringify(data)],
      { ROAD_NOT_FOUND: ["道路不存在", "NOT_FOUND", 404] },
    ),
  );
}
