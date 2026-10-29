import { z } from "zod";
import { AppError, actorTransaction, callProcedure } from "./db.mjs";
import { sql } from "./sql-statements.mjs";
import { pageById } from "./pagination.mjs";
import { idSchema } from "./validation.mjs";

export async function listCarbonEntries(pool, actor, before = null) {
  const [rows] = await pool.query(sql("carbon_entries_own"), [
    actor.id,
    before,
    before,
  ]);
  return pageById(rows, "entries");
}

export function reviewOrderQualification(pool, actor, orderId, input) {
  if (actor.role !== "ADMIN")
    throw new AppError("仅管理员可复核订单", "FORBIDDEN", 403);
  const data = z
    .object({
      decision: z.enum(["VALID", "EXCLUDED"]),
      reason: z.string().trim().min(2).max(300),
    })
    .parse(input);
  const parsedId = idSchema.parse(orderId);
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
      order_id: idSchema,
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
      {
        INVALID_ADJUSTMENT: ["只能调整已支付订单", "INVALID_ADJUSTMENT", 409],
        INVALID_ADJUSTMENT_AMOUNT: [
          "减排量调整须为最多四位小数的有效数字",
          "INVALID_ADJUSTMENT_AMOUNT",
          400,
        ],
        ADJUSTMENT_ZERO: [
          "调整后的积分和减排量不能同时为零",
          "INVALID_ADJUSTMENT",
          400,
        ],
        ADJUSTMENT_IDEMPOTENCY_CONFLICT: [
          "此调整请求编号已用于不同内容",
          "IDEMPOTENCY_CONFLICT",
          409,
        ],
        INSUFFICIENT_CARBON_BALANCE: [
          "账户积分或减排余额不足，无法扣减",
          "INSUFFICIENT_BALANCE",
          409,
        ],
      },
    );
    return { ...row, duplicate: Boolean(row.duplicate) };
  });
}
