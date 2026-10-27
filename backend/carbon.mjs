import { z } from "zod";
import { AppError, actorTransaction, callProcedure } from "./db.mjs";

const id = z.coerce.number().int().positive().safe();

export function reviewOrderQualification(pool, actor, orderId, input) {
  if (actor.role !== "ADMIN")
    throw new AppError("仅管理员可复核订单", "FORBIDDEN", 403);
  const data = z
    .object({
      decision: z.enum(["VALID", "EXCLUDED"]),
      reason: z.string().trim().min(2).max(300),
    })
    .parse(input);
  const parsedId = id.parse(orderId);
  return actorTransaction(pool, actor, (connection) =>
    callProcedure(
      connection,
      "CALL sp_review_order_qualification(?,?,?,?)",
      [actor.id, parsedId, data.decision, data.reason],
      {
        ORDER_NOT_FOUND: ["订单不存在", "NOT_FOUND", 404],
        ORDER_NOT_REVIEWABLE: [
          "订单不在待复核状态",
          "ORDER_NOT_REVIEWABLE",
          409,
        ],
      },
    ),
  );
}

export function adjustCarbon(pool, actor, input) {
  if (actor.role !== "ADMIN")
    throw new AppError("仅管理员可调整积分", "FORBIDDEN", 403);
  const data = z
    .object({
      order_id: id,
      points_change: z.number().int().min(-100000).max(100000),
      carbon_kg_change: z.number().finite().min(-1000).max(1000),
      reason: z.string().trim().min(2).max(300),
      idempotency_key: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/),
    })
    .refine((v) => v.points_change !== 0 || v.carbon_kg_change !== 0)
    .parse(input);
  return actorTransaction(pool, actor, async (connection) => {
    const row = await callProcedure(
      connection,
      "CALL sp_adjust_carbon(?,?,?,?,?,?,?)",
      [
        actor.id,
        data.order_id,
        data.points_change,
        data.carbon_kg_change,
        data.reason,
        data.idempotency_key,
        JSON.stringify(data),
      ],
      { INVALID_ADJUSTMENT: ["只能调整已支付订单", "INVALID_ADJUSTMENT", 409] },
    );
    return { ...row, duplicate: Boolean(row.duplicate) };
  });
}
