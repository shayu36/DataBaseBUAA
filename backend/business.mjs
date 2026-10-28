import { z } from "zod";
import { AppError, actorTransaction, callProcedure } from "./db.mjs";
import { findRoute, findRoutes } from "./analytics.mjs";
import { sql } from "./sql-statements.mjs";
export const idSchema = z.coerce.number().int().positive().safe();
// Reject values that cannot be represented in return_attempts before writing evidence.
const coord = z.number().finite().min(-99999999.99).max(99999999.99);
const need = (ok, message, code = "INVALID_STATE", status = 409) => {
  if (!ok) throw new AppError(message, code, status);
};
export function requireAdmin(user) {
  need(user.role === "ADMIN", "仅管理员可执行此操作", "FORBIDDEN", 403);
}
export async function routeGraph(c) {
  const [result] = await c.query("CALL sp_route_graph()");
  return result;
}
export function routesForGraph(result, from, to, mode = "shortest") {
  const [nodes, edges] = result;
  const start = nodes.find((n) => Number(n.zone_id) === Number(from)),
    end = nodes.find((n) => Number(n.zone_id) === Number(to));
  need(start && end, "该停车区尚未连接路网", "NO_ROUTE", 400);
  try {
    if (mode === "all")
      return {
        nodes,
        edges,
        routes: findRoutes(nodes, edges, start.id, end.id),
      };
    return { ...findRoute(nodes, edges, start.id, end.id, mode), nodes, edges };
  } catch {
    throw new AppError("两处停车区之间没有可用路线", "NO_ROUTE", 409);
  }
}
export async function routeForZones(c, from, to, mode = "shortest") {
  return routesForGraph(await routeGraph(c), from, to, mode);
}
const startRideErrors = {
  ACTIVE_RIDE: ["请先结束当前骑行", "ACTIVE_RIDE", 409],
  UNPAID_ORDER: ["请先支付待结算订单", "UNPAID_ORDER", 409],
  BIKE_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
  ZONE_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
  BIKE_UNAVAILABLE: ["车辆当前不可借用", "BIKE_UNAVAILABLE", 409],
  ZONE_CLOSED: ["停车区已关闭", "INVALID_STATE", 409],
};
export async function startRide(pool, user, input) {
  const { bike_id } = z.object({ bike_id: idSchema }).parse(input);
  return actorTransaction(pool, user, async (connection) => {
    const row = await callProcedure(
      connection,
      "CALL sp_start_ride(?,?)",
      [user.id, bike_id],
      startRideErrors,
    );
    return { id: row.id };
  });
}
export async function returnRide(pool, user, id, input) {
  const d = z
    .object({
      zone_id: idSchema,
      x: coord.optional(),
      y: coord.optional(),
      captured_at: z.preprocess(
        (value) => (value === null ? undefined : value),
        z.coerce.date().optional(),
      ),
      location_source: z
        .enum(["MAP_SIMULATION", "DEVICE_GPS", "MANUAL"])
        .default("MAP_SIMULATION"),
      route_mode: z
        .enum(["shortest", "safe", "comfortable"])
        .default("shortest"),
    })
    .parse(input);
  need(
    (d.x === undefined) === (d.y === undefined) &&
      (d.x !== undefined || d.location_source === "MAP_SIMULATION"),
    "模拟还车可只选停车点；设备定位须同时提供横纵坐标",
    "INVALID_INPUT",
    400,
  );
  const orderId = idSchema.parse(id);
  const result = await actorTransaction(pool, user, async (connection) => {
    let x = d.x,
      y = d.y;
    if (x === undefined) {
      const [[zone]] = await connection.query(sql("return_zone_coordinates"), [
        d.zone_id,
      ]);
      need(zone, "记录不存在", "NOT_FOUND", 404);
      x = zone.x;
      y = zone.y;
    }
    const prepared = await callProcedure(
      connection,
      "CALL sp_prepare_ride_return(?,?,?,?,?,?,?)",
      [
        user.id,
        orderId,
        d.zone_id,
        x,
        y,
        d.captured_at || null,
        d.location_source,
      ],
      {
        ORDER_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
        ZONE_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
        RETURN_FORBIDDEN: ["不能操作他人订单", "FORBIDDEN", 403],
        RETURN_INVALID_STATE: ["该订单不在骑行中", "INVALID_STATE", 409],
        LOCATION_TIMESTAMP_REQUIRED: [
          "设备 GPS 定位必须提供采集时间",
          "LOCATION_TIMESTAMP_REQUIRED",
          400,
        ],
      },
    );
    if (prepared.rejected) return prepared;
    const route = await routeForZones(
      connection,
      prepared.start_zone_id,
      d.zone_id,
      d.route_mode,
    );
    return callProcedure(
      connection,
      "CALL sp_finish_ride_return(?,?,?,?,?,?,?,?,?,?)",
      [
        user.id,
        orderId,
        d.zone_id,
        x,
        y,
        prepared.captured_at,
        d.location_source,
        d.route_mode,
        Math.round(route.distance_m),
        prepared.return_time,
      ],
    );
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
  const orderId = idSchema.parse(id);
  return actorTransaction(pool, user, async (connection) => {
    const row = await callProcedure(
      connection,
      "CALL sp_pay_ride(?,?,?)",
      [user.id, orderId, idempotency_key],
      {
        ORDER_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
        PAYMENT_FORBIDDEN: ["不能支付他人订单", "FORBIDDEN", 403],
        INVALID_PAYMENT_KEY: ["支付请求编号格式无效", "INVALID_INPUT", 400],
        IDEMPOTENCY_CONFLICT: [
          "此支付请求编号已用于另一订单",
          "IDEMPOTENCY_CONFLICT",
          409,
        ],
        ORDER_ALREADY_PAID: [
          "订单已支付，请使用原支付请求编号重试或查看支付记录",
          "ORDER_ALREADY_PAID",
          409,
        ],
        PAYMENT_INVALID_STATE: [
          "只能支付已结束的未付款订单",
          "INVALID_STATE",
          409,
        ],
      },
    );
    if (row.duplicate) return { ...row, duplicate: true };
    const { awarded, points, carbon_kg, reason, ...payment } = row;
    const credit =
      reason === null
        ? { awarded: Boolean(awarded), points, carbon_kg }
        : { awarded: false, reason };
    return { ...payment, duplicate: false, credit };
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
const dispatchErrors = {
  ZONE_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
  BIKE_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
  TASK_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
  STAFF_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
  STAFF_UNAVAILABLE: ["该员工不在岗或岗位不匹配", "INVALID_STATE", 409],
  DISPATCH_ZONE_CLOSED: ["调度停车区必须开放", "INVALID_STATE", 409],
  DISPATCH_TARGET_CLOSED: ["目标停车区已关闭", "INVALID_STATE", 409],
  DISPATCH_ZONE_FULL: ["目标停车区车位不足", "ZONE_FULL", 409],
  BIKE_UNAVAILABLE: ["所选车辆不在源停车区或已被占用", "BIKE_UNAVAILABLE", 409],
  DISPATCH_FORBIDDEN: ["没有此任务的处理权限", "FORBIDDEN", 403],
  TASK_NOT_ASSIGNED: ["只能处理分配给自己的任务", "FORBIDDEN", 403],
  DISPATCH_NOT_PENDING_ASSIGN: ["只可分配待执行任务", "INVALID_STATE", 409],
  DISPATCH_NOT_READY: ["任务须待执行且已分配人员", "INVALID_STATE", 409],
  DISPATCH_NOT_STARTED: ["任务尚未开始或已结束", "INVALID_STATE", 409],
  DISPATCH_CANNOT_CANCEL: [
    "仅未开始的任务可以取消；运输中的任务请完成入库",
    "INVALID_STATE",
    409,
  ],
  INVALID_DISPATCH_INPUT: ["无效调度请求", "INVALID_INPUT", 400],
};
export async function createDispatchInConnection(connection, user, data) {
  requireAdmin(user);
  return callProcedure(
    connection,
    "CALL sp_create_dispatch(?,?,?,?,?,?)",
    [
      user.id,
      data.source_zone_id,
      data.target_zone_id,
      JSON.stringify(data.bike_ids),
      data.staff_id ?? null,
      JSON.stringify(data),
    ],
    dispatchErrors,
  );
}
export async function dispatchAction(pool, user, id, action, input) {
  need(
    ["assign", "start", "complete", "cancel"].includes(action),
    "无效任务动作",
    "INVALID_INPUT",
    400,
  );
  if (action === "assign" || action === "cancel") requireAdmin(user);
  const staffId = action === "assign" ? idSchema.parse(input.staff_id) : null;
  return actorTransaction(pool, user, async (connection) => {
    await callProcedure(
      connection,
      "CALL sp_dispatch_action(?,?,?,?)",
      [user.id, idSchema.parse(id), action, staffId],
      dispatchErrors,
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
  return actorTransaction(pool, user, (connection) =>
    callProcedure(
      connection,
      "CALL sp_report_fault(?,?,?,?)",
      [user.id, d.bike_id, d.fault_type, d.description],
      {
        BIKE_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
        FAULT_BIKE_UNAVAILABLE: [
          "该车辆已报修、调度中或已退役",
          "INVALID_STATE",
          409,
        ],
        FAULT_FORBIDDEN: ["只能报修本人正在使用的车辆", "FORBIDDEN", 403],
      },
    ),
  );
}
export async function maintenanceAction(pool, user, id, action, input) {
  need(
    ["assign", "complete"].includes(action),
    "无效维修动作",
    "INVALID_INPUT",
    400,
  );
  if (action === "assign") requireAdmin(user);
  const staffId = action === "assign" ? idSchema.parse(input.staff_id) : null;
  const result =
    action === "complete"
      ? z.string().trim().min(3).max(500).parse(input.result)
      : null;
  return actorTransaction(pool, user, async (connection) => {
    await callProcedure(
      connection,
      "CALL sp_maintenance_action(?,?,?,?,?)",
      [user.id, idSchema.parse(id), action, staffId, result],
      {
        TICKET_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
        STAFF_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
        STAFF_UNAVAILABLE: ["该员工不在岗或岗位不匹配", "INVALID_STATE", 409],
        MAINTENANCE_FORBIDDEN: ["没有此任务的处理权限", "FORBIDDEN", 403],
        TASK_NOT_ASSIGNED: ["只能处理分配给自己的任务", "FORBIDDEN", 403],
        TICKET_COMPLETED: ["工单已完成", "INVALID_STATE", 409],
        TICKET_NOT_ASSIGNED: ["请先分配维修人员", "INVALID_STATE", 409],
        BIKE_NOT_RETURNED: ["车辆尚未归还或不在维修状态", "INVALID_STATE", 409],
      },
    );
    return { ok: true };
  });
}
