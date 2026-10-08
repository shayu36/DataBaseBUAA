import { z } from "zod";
import { AppError, actorTransaction } from "./db.mjs";
import { findRoute } from "./analytics.mjs";
import { awardCarbonForOrder, classifyRideForCredit } from "./carbon.mjs";
export const idSchema = z.coerce.number().int().positive().safe();
// Integer metres * 21 / 100000 kg; round half-up to four decimals without
// applying toFixed directly to a binary approximation of the coefficient.
export const carbonKilograms = (distance) =>
  (Math.round((distance * 21) / 10) / 10000).toFixed(4);
const coord = z.number().finite();
const need = (ok, message, code = "INVALID_STATE", status = 409) => {
  if (!ok) throw new AppError(message, code, status);
};
export function requireAdmin(user) {
  need(user.role === "ADMIN", "仅管理员可执行此操作", "FORBIDDEN", 403);
}
export async function audit(c, user, action, type, id, detail = {}) {
  await c.query(
    "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?)",
    [user.id, action, type, id, JSON.stringify(detail)],
  );
}
async function get(c, table, id) {
  const [[r]] = await c.query(
    "SELECT * FROM " + table + " WHERE id=? FOR UPDATE",
    [idSchema.parse(id)],
  );
  need(r, "记录不存在", "NOT_FOUND", 404);
  return r;
}
async function zone(c, id) {
  await get(c, "parking_zones", id);
  const [[r]] = await c.query("SELECT * FROM v_zone_inventory WHERE id=?", [
    id,
  ]);
  return r;
}
async function activeStaff(c, id, job) {
  const s = await get(c, "staff", id);
  const [[u]] = await c.query("SELECT status FROM users WHERE id=?", [
    s.user_id,
  ]);
  need(
    s.status === "ACTIVE" &&
      u?.status === "ACTIVE" &&
      (s.job === job || s.job === "BOTH"),
    "该员工不在岗或岗位不匹配",
  );
  return s;
}
async function assigned(c, user, staffId, job) {
  if (user.role === "ADMIN") return;
  need(
    user.role === "OPERATOR" && staffId,
    "没有此任务的处理权限",
    "FORBIDDEN",
    403,
  );
  const s = await activeStaff(c, staffId, job);
  need(s.user_id === user.id, "只能处理分配给自己的任务", "FORBIDDEN", 403);
}
export async function routeForZones(c, from, to, mode = "shortest") {
  const [nodes] = await c.query("SELECT * FROM road_nodes ORDER BY id"),
    [edges] = await c.query("SELECT * FROM road_edges ORDER BY id");
  const start = nodes.find((n) => Number(n.zone_id) === Number(from)),
    end = nodes.find((n) => Number(n.zone_id) === Number(to));
  need(start && end, "该停车区尚未连接路网", "NO_ROUTE", 400);
  try {
    return { ...findRoute(nodes, edges, start.id, end.id, mode), nodes, edges };
  } catch {
    throw new AppError("两处停车区之间没有可用路线", "NO_ROUTE", 409);
  }
}
export async function startRide(pool, user, input) {
  const { bike_id } = z.object({ bike_id: idSchema }).parse(input);
  return actorTransaction(pool, user, async (c) => {
    const u = await get(c, "users", user.id);
    need(u.status === "ACTIVE", "账号已停用", "FORBIDDEN", 403);
    const [[running]] = await c.query(
      "SELECT id FROM ride_orders WHERE user_id=? AND status='RUNNING'",
      [user.id],
    );
    need(!running, "请先结束当前骑行", "ACTIVE_RIDE");
    const [[unpaid]] = await c.query(
      "SELECT id FROM ride_orders WHERE user_id=? AND status='UNPAID'",
      [user.id],
    );
    need(!unpaid, "请先支付待结算订单", "UNPAID_ORDER");
    const b = await get(c, "bikes", bike_id);
    need(b.status === "AVAILABLE", "车辆当前不可借用", "BIKE_UNAVAILABLE");
    const s = await zone(c, b.current_zone_id);
    need(s.status === "ACTIVE", "停车区已关闭");
    const [r] = await c.query(
      "INSERT INTO ride_orders(user_id,bike_id,start_zone_id) VALUES(?,?,?)",
      [user.id, b.id, s.id],
    );
    await c.query(
      "UPDATE bikes SET status='RIDING',current_zone_id=NULL WHERE id=?",
      [b.id],
    );
    await audit(c, user, "RIDE_START", "ride_orders", r.insertId, { bike_id });
    return { id: r.insertId };
  });
}
export async function returnRide(pool, user, id, input) {
  const d = z
    .object({
      zone_id: idSchema,
      x: coord,
      y: coord,
      captured_at: z.coerce.date().optional(),
      location_source: z
        .enum(["MAP_SIMULATION", "DEVICE_GPS", "MANUAL"])
        .default("MAP_SIMULATION"),
      route_mode: z
        .enum(["shortest", "safe", "comfortable"])
        .default("shortest"),
    })
    .parse(input);
  const result = await actorTransaction(pool, user, async (c) => {
    const r = await get(c, "ride_orders", id);
    need(r.user_id === user.id, "不能操作他人订单", "FORBIDDEN", 403);
    need(r.status === "RUNNING", "该订单不在骑行中");
    const target = await zone(c, d.zone_id);
    await get(c, "bikes", r.bike_id);
    const [[{ now }]] = await c.query("SELECT UTC_TIMESTAMP(3) now"),
      captured = d.captured_at || new Date(now),
      capturedMs = captured.getTime(),
      nowMs = new Date(now).getTime();
    let reason = null;
    if (d.x < 0 || d.x > 2000 || d.y < 0 || d.y > 2000)
      reason = "INVALID_LOCATION";
    else if (
      capturedMs < new Date(r.started_at).getTime() ||
      capturedMs > nowMs + 30000 ||
      nowMs - capturedMs > 300000
    )
      reason = "LOCATION_STALE";
    else if (target.status !== "ACTIVE") reason = "ZONE_CLOSED";
    else if (
      Math.hypot(d.x - Number(target.x), d.y - Number(target.y)) >
      Number(target.radius) + 1e-8
    )
      reason = "OUTSIDE_FENCE";
    else if (
      Number(target.occupied) + Number(target.reserved) >=
      target.capacity
    )
      reason = "ZONE_FULL";
    if (reason) {
      await c.query(
        "INSERT INTO return_attempts(order_id,zone_id,x,y,reason,location_captured_at,location_source) VALUES(?,?,?,?,?,?,?)",
        [r.id, d.zone_id, d.x, d.y, reason, captured, d.location_source],
      );
      return { rejected: reason };
    }
    const route = await routeForZones(
      c,
      r.start_zone_id,
      d.zone_id,
      d.route_mode,
    );
    const fee =
      Math.max(
        1,
        Math.ceil((new Date(now) - new Date(r.started_at)) / 1800000),
      ) * 100;
    const [[open]] = await c.query(
      "SELECT id FROM maintenance_tickets WHERE bike_id=? AND status<>'COMPLETED'",
      [r.bike_id],
    );
    const completed = {
        ...r,
        ended_at: now,
        distance_m: Math.round(route.distance_m),
      },
      qualification = classifyRideForCredit(completed);
    await c.query(
      "UPDATE ride_orders SET end_zone_id=?,ended_at=?,amount_cents=?,distance_m=?,route_mode=?,qualification_status=?,qualification_reason=?,return_x=?,return_y=?,location_captured_at=?,location_source=?,status='UNPAID' WHERE id=?",
      [
        d.zone_id,
        now,
        fee,
        completed.distance_m,
        d.route_mode,
        qualification.status,
        qualification.reason,
        d.x,
        d.y,
        captured,
        d.location_source,
        r.id,
      ],
    );
    await c.query("UPDATE bikes SET status=?,current_zone_id=? WHERE id=?", [
      open ? "MAINTENANCE" : "AVAILABLE",
      d.zone_id,
      r.bike_id,
    ]);
    await audit(c, user, "RIDE_RETURN", "ride_orders", r.id, {
      zone_id: d.zone_id,
      x: d.x,
      y: d.y,
    });
    return {
      id: r.id,
      amount_cents: fee,
      distance_m: Math.round(route.distance_m),
    };
  });
  if (result.rejected)
    throw new AppError(
      {
        INVALID_LOCATION: "位置坐标无效，请重新选择还车位置",
        LOCATION_STALE: "位置信息已过期，请重新获取位置后还车",
        OUTSIDE_FENCE: "当前位置在电子围栏外，请进入停车区后还车",
        ZONE_FULL: "该停车区车位已满或已预留，请选择其他停车区",
        ZONE_CLOSED: "该停车区已关闭",
      }[result.rejected],
      result.rejected,
      409,
    );
  return result;
}
export async function payRide(pool, user, id, input) {
  const { idempotency_key } = z
    .object({
      idempotency_key: z
        .string()
        .min(8)
        .max(80)
        .regex(/^[a-zA-Z0-9_-]+$/),
    })
    .parse(input);
  return actorTransaction(pool, user, async (c) => {
    const r = await get(c, "ride_orders", id);
    need(r.user_id === user.id, "不能支付他人订单", "FORBIDDEN", 403);
    const key = user.id + ":" + idempotency_key;
    const [[sameKey]] = await c.query(
      "SELECT * FROM payments WHERE idempotency_key=?",
      [key],
    );
    need(
      !sameKey || sameKey.order_id === r.id,
      "此支付请求编号已用于另一订单",
      "IDEMPOTENCY_CONFLICT",
    );
    const [[existing]] = await c.query(
      "SELECT * FROM payments WHERE order_id=?",
      [r.id],
    );
    if (existing) return { ...existing, duplicate: true };
    need(r.status === "UNPAID", "只能支付已结束的未付款订单");
    const [p] = await c.query(
      "INSERT INTO payments(order_id,idempotency_key,amount_cents) VALUES(?,?,?)",
      [r.id, key, r.amount_cents],
    );
    await c.query("UPDATE ride_orders SET status='PAID' WHERE id=?", [r.id]);
    const credit = await awardCarbonForOrder(c, r.id, user.id);
    await audit(c, user, "SIMULATED_PAYMENT", "ride_orders", r.id, {
      amount_cents: r.amount_cents,
    });
    return {
      id: p.insertId,
      order_id: r.id,
      amount_cents: r.amount_cents,
      duplicate: false,
      credit,
    };
  });
}
export async function createDispatch(pool, user, input) {
  requireAdmin(user);
  const d = z
    .object({
      source_zone_id: idSchema,
      target_zone_id: idSchema,
      bike_ids: z
        .array(idSchema)
        .min(1)
        .max(100)
        .refine((v) => new Set(v).size === v.length),
      staff_id: idSchema.optional(),
    })
    .parse(input);
  need(
    d.source_zone_id !== d.target_zone_id,
    "调出与调入停车区不能相同",
    "INVALID_INPUT",
    400,
  );
  return actorTransaction(pool, user, (c) =>
    createDispatchInConnection(c, user, d),
  );
}
export async function createDispatchInConnection(c, user, d) {
  requireAdmin(user);
  need(
    d.source_zone_id !== d.target_zone_id,
    "调出与调入停车区不能相同",
    "INVALID_INPUT",
    400,
  );
  const source = await zone(c, d.source_zone_id),
    target = await zone(c, d.target_zone_id);
  need(
    source.status === "ACTIVE" && target.status === "ACTIVE",
    "调度停车区必须开放",
  );
  need(
    Number(target.occupied) + Number(target.reserved) + d.bike_ids.length <=
      target.capacity,
    "目标停车区车位不足",
    "ZONE_FULL",
  );
  if (d.staff_id) await activeStaff(c, d.staff_id, "DISPATCH");
  for (const bikeId of [...d.bike_ids].sort((a, b) => a - b)) {
    const b = await get(c, "bikes", bikeId);
    need(
      b.status === "AVAILABLE" && b.current_zone_id === source.id,
      "所选车辆不在源停车区或已被占用",
      "BIKE_UNAVAILABLE",
    );
  }
  const [t] = await c.query(
    "INSERT INTO dispatch_tasks(staff_id,source_zone_id,target_zone_id) VALUES(?,?,?)",
    [d.staff_id ?? null, source.id, target.id],
  );
  for (const bikeId of d.bike_ids) {
    await c.query("INSERT INTO dispatch_bikes(task_id,bike_id) VALUES(?,?)", [
      t.insertId,
      bikeId,
    ]);
    await c.query("UPDATE bikes SET status='DISPATCHING' WHERE id=?", [bikeId]);
  }
  await audit(c, user, "DISPATCH_CREATE", "dispatch_tasks", t.insertId, d);
  return { id: t.insertId };
}
export async function dispatchAction(pool, user, id, action, input) {
  need(
    ["assign", "start", "complete", "cancel"].includes(action),
    "无效任务动作",
    "INVALID_INPUT",
    400,
  );
  if (action === "assign" || action === "cancel") requireAdmin(user);
  return actorTransaction(pool, user, async (c) => {
    const t = await get(c, "dispatch_tasks", id);
    if (action === "assign") {
      need(t.status === "PENDING", "只可分配待执行任务");
      const staffId = idSchema.parse(input.staff_id);
      await activeStaff(c, staffId, "DISPATCH");
      await c.query("UPDATE dispatch_tasks SET staff_id=? WHERE id=?", [
        staffId,
        t.id,
      ]);
    } else {
      await assigned(c, user, t.staff_id, "DISPATCH");
      const [items] = await c.query(
        "SELECT b.* FROM bikes b JOIN dispatch_bikes d ON b.id=d.bike_id WHERE d.task_id=? ORDER BY b.id FOR UPDATE",
        [t.id],
      );
      if (action === "start") {
        need(t.status === "PENDING" && t.staff_id, "任务须待执行且已分配人员");
        await activeStaff(c, t.staff_id, "DISPATCH");
        await c.query(
          "UPDATE dispatch_tasks SET status='IN_PROGRESS',started_at=UTC_TIMESTAMP(3) WHERE id=?",
          [t.id],
        );
        for (const b of items)
          await c.query("UPDATE bikes SET current_zone_id=NULL WHERE id=?", [
            b.id,
          ]);
      } else if (action === "complete") {
        need(t.status === "IN_PROGRESS", "任务尚未开始或已结束");
        const target = await zone(c, t.target_zone_id);
        need(target.status === "ACTIVE", "目标停车区已关闭");
        need(
          Number(target.occupied) + Number(target.reserved) <= target.capacity,
          "目标停车区车位不足",
          "ZONE_FULL",
        );
        for (const b of items)
          await c.query(
            "UPDATE bikes SET status='AVAILABLE',current_zone_id=? WHERE id=?",
            [target.id, b.id],
          );
        await c.query(
          "UPDATE dispatch_tasks SET status='COMPLETED',completed_at=UTC_TIMESTAMP(3) WHERE id=?",
          [t.id],
        );
      } else {
        need(
          t.status === "PENDING",
          "仅未开始的任务可以取消；运输中的任务请完成入库",
        );
        for (const b of items)
          await c.query("UPDATE bikes SET status='AVAILABLE' WHERE id=?", [
            b.id,
          ]);
        await c.query(
          "UPDATE dispatch_tasks SET status='CANCELLED',completed_at=UTC_TIMESTAMP(3) WHERE id=?",
          [t.id],
        );
      }
    }
    await audit(
      c,
      user,
      "DISPATCH_" + action.toUpperCase(),
      "dispatch_tasks",
      t.id,
    );
    return { ok: true };
  });
}
export async function reportFault(pool, user, input) {
  const d = z
    .object({
      bike_id: idSchema,
      fault_type: z.enum(["BRAKE", "TIRE", "LOCK", "CHAIN", "OTHER"]),
      description: z.string().trim().min(3).max(500),
    })
    .parse(input);
  return actorTransaction(pool, user, async (c) => {
    const b = await get(c, "bikes", d.bike_id);
    need(
      ["AVAILABLE", "RIDING"].includes(b.status),
      "该车辆已报修、调度中或已退役",
    );
    if (b.status === "RIDING") {
      const [[r]] = await c.query(
        "SELECT user_id FROM ride_orders WHERE bike_id=? AND status='RUNNING'",
        [b.id],
      );
      need(
        r?.user_id === user.id,
        "只能报修本人正在使用的车辆",
        "FORBIDDEN",
        403,
      );
    }
    const [t] = await c.query(
      "INSERT INTO maintenance_tickets(bike_id,reporter_id,fault_type,description) VALUES(?,?,?,?)",
      [b.id, user.id, d.fault_type, d.description],
    );
    if (b.status === "AVAILABLE")
      await c.query("UPDATE bikes SET status='MAINTENANCE' WHERE id=?", [b.id]);
    await audit(c, user, "FAULT_REPORT", "maintenance_tickets", t.insertId);
    return { id: t.insertId };
  });
}
export async function maintenanceAction(pool, user, id, action, input) {
  need(
    ["assign", "complete"].includes(action),
    "无效维修动作",
    "INVALID_INPUT",
    400,
  );
  if (action === "assign") requireAdmin(user);
  return actorTransaction(pool, user, async (c) => {
    const t = await get(c, "maintenance_tickets", id);
    if (action === "assign") {
      need(t.status !== "COMPLETED", "工单已完成");
      const staffId = idSchema.parse(input.staff_id);
      await activeStaff(c, staffId, "MAINTENANCE");
      await c.query(
        "UPDATE maintenance_tickets SET staff_id=?,status='ASSIGNED' WHERE id=?",
        [staffId, t.id],
      );
    } else {
      await assigned(c, user, t.staff_id, "MAINTENANCE");
      need(t.status === "ASSIGNED", "请先分配维修人员");
      const result = z.string().trim().min(3).max(500).parse(input.result),
        b = await get(c, "bikes", t.bike_id);
      need(
        b.status === "MAINTENANCE" && b.current_zone_id,
        "车辆尚未归还或不在维修状态",
      );
      await c.query(
        "UPDATE maintenance_tickets SET status='COMPLETED',result=?,completed_at=UTC_TIMESTAMP(3) WHERE id=?",
        [result, t.id],
      );
      await c.query(
        "UPDATE bikes SET status='AVAILABLE',last_service_at=UTC_TIMESTAMP(3) WHERE id=?",
        [b.id],
      );
    }
    await audit(
      c,
      user,
      "MAINTENANCE_" + action.toUpperCase(),
      "maintenance_tickets",
      t.id,
    );
    return { ok: true };
  });
}
