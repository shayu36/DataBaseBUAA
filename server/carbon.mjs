import Decimal from "decimal.js";
import { z } from "zod";
import { AppError, actorTransaction } from "./db.mjs";

const id = z.coerce.number().int().positive().safe();
const need = (ok, message, code = "INVALID_STATE", status = 409) => {
  if (!ok) throw new AppError(message, code, status);
};
async function audit(c, actor, action, type, entityId, detail) {
  await c.query(
    "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?)",
    [actor.id, action, type, entityId, JSON.stringify(detail)],
  );
}
async function rules(c) {
  const [[row]] = await c.query(
    "SELECT value FROM system_settings WHERE name='carbon'",
  );
  const value = row
    ? typeof row.value === "string"
      ? JSON.parse(row.value)
      : row.value
    : {};
  return {
    factor: new Decimal(value.kg_per_km ?? 0.21),
    pointsPerKm: new Decimal(value.points_per_km ?? 10),
    version: String(value.rule_version || "carbon-v1"),
  };
}
export function classifyRideForCredit(order) {
  const duration =
    (new Date(order.ended_at).getTime() -
      new Date(order.started_at).getTime()) /
    1000;
  if (Number(order.distance_m) >= 500 && duration > 0 && duration < 60)
    return {
      status: "UNDER_REVIEW",
      reason: "行程时长与路网估算距离组合异常，需人工复核",
    };
  return { status: "VALID", reason: null };
}
export async function awardCarbonForOrder(c, orderId, actorId = null) {
  const [[order]] = await c.query(
    "SELECT r.*,(SELECT COUNT(*) FROM payments p WHERE p.order_id=r.id) paid FROM ride_orders r WHERE r.id=? FOR UPDATE",
    [orderId],
  );
  need(order, "订单不存在", "NOT_FOUND", 404);
  if (order.status !== "PAID" || order.qualification_status !== "VALID")
    return { awarded: false, reason: order.qualification_status };
  const config = await rules(c),
    km = new Decimal(order.distance_m).div(1000),
    points = km.mul(config.pointsPerKm).floor().toNumber(),
    carbon = km.mul(config.factor).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  const [result] = await c.query(
    `INSERT IGNORE INTO carbon_transactions(order_id,entry_type,idempotency_key,distance_m,points_change,carbon_kg_change,factor_kg_per_km,rule_version,reason,actor_id)
     VALUES(?,'AWARD',?,?,?,?,?,?,?,?)`,
    [
      order.id,
      `award-${order.id}`,
      order.distance_m,
      points,
      carbon.toFixed(4),
      config.factor.toNumber(),
      config.version,
      "有效已支付行程积分发放",
      actorId,
    ],
  );
  return {
    awarded: result.affectedRows === 1,
    points,
    carbon_kg: carbon.toNumber(),
  };
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
  return actorTransaction(pool, actor, async (c) => {
    const [[order]] = await c.query(
      "SELECT * FROM ride_orders WHERE id=? FOR UPDATE",
      [id.parse(orderId)],
    );
    need(order, "订单不存在", "NOT_FOUND", 404);
    need(
      order.qualification_status === "UNDER_REVIEW",
      "订单不在待复核状态",
      "ORDER_NOT_REVIEWABLE",
    );
    await c.query(
      "UPDATE ride_orders SET qualification_status=?,qualification_reason=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3) WHERE id=?",
      [data.decision, data.reason, actor.id, order.id],
    );
    if (data.decision === "VALID")
      await awardCarbonForOrder(c, order.id, actor.id);
    else {
      const [[award]] = await c.query(
        "SELECT * FROM carbon_transactions WHERE order_id=? AND entry_type='AWARD' FOR UPDATE",
        [order.id],
      );
      if (award)
        await c.query(
          `INSERT INTO carbon_transactions(order_id,entry_type,idempotency_key,distance_m,points_change,carbon_kg_change,factor_kg_per_km,rule_version,reason,actor_id)
           VALUES(?,'ADJUSTMENT',?,0,?,?,?,?,?,?)`,
          [
            order.id,
            `exclude-${order.id}`,
            -Number(award.points_change),
            new Decimal(award.carbon_kg_change).negated().toFixed(4),
            award.factor_kg_per_km,
            award.rule_version,
            `订单排除冲销：${data.reason}`,
            actor.id,
          ],
        );
    }
    await audit(c, actor, "ORDER_QUALIFICATION", "ride_orders", order.id, data);
    return { id: order.id, qualification_status: data.decision };
  });
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
  return actorTransaction(pool, actor, async (c) => {
    const [[order]] = await c.query(
      "SELECT * FROM ride_orders WHERE id=? FOR UPDATE",
      [data.order_id],
    );
    need(order?.status === "PAID", "只能调整已支付订单", "INVALID_ADJUSTMENT");
    const [[existing]] = await c.query(
      "SELECT * FROM carbon_transactions WHERE idempotency_key=?",
      [data.idempotency_key],
    );
    if (existing) return { ...existing, duplicate: true };
    const config = await rules(c);
    const [row] = await c.query(
      `INSERT INTO carbon_transactions(order_id,entry_type,idempotency_key,distance_m,points_change,carbon_kg_change,factor_kg_per_km,rule_version,reason,actor_id)
       VALUES(?,'ADJUSTMENT',?,0,?,?,?,?,?,?)`,
      [
        order.id,
        data.idempotency_key,
        data.points_change,
        new Decimal(data.carbon_kg_change).toDecimalPlaces(4).toFixed(4),
        config.factor.toNumber(),
        config.version,
        data.reason,
        actor.id,
      ],
    );
    await audit(
      c,
      actor,
      "CARBON_ADJUST",
      "carbon_transactions",
      row.insertId,
      data,
    );
    return { id: row.insertId, duplicate: false };
  });
}
