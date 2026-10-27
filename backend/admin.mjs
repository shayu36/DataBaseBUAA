import { z } from "zod";
import bcrypt from "bcryptjs";
import { AppError, actorTransaction, callProcedure } from "./db.mjs";
import { requireAdmin, idSchema } from "./business.mjs";
const need = (ok, message, code = "INVALID_STATE", status = 409) => {
  if (!ok) throw new AppError(message, code, status);
};
const text = (max) => z.string().trim().min(1).max(max);
const coord = z.number().finite().min(0).max(2000);
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const t = new Date(s + "T00:00:00Z");
    return (
      Number.isFinite(t.getTime()) &&
      t.toISOString().slice(0, 10) === s &&
      s >= "1000-01-01" &&
      s <= new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    );
  }, "投放日期须为真实且不晚于今天的日期");
const zoneSchema = z.object({
  id: idSchema.optional(),
  name: text(60),
  location: text(160),
  x: coord,
  y: coord,
  radius: z.number().finite().min(0.005).max(2000),
  capacity: z.number().int().min(1).max(1000),
  status: z.enum(["ACTIVE", "CLOSED"]),
});
const bikeSchema = z.object({
  id: idSchema.optional(),
  code: text(30),
  zone_id: idSchema,
  deployed_at: dateSchema.optional(),
  status: z.enum(["AVAILABLE", "RETIRED"]).optional(),
});
const password = z
  .string()
  .min(8)
  .max(72)
  .regex(/[a-zA-Z]/)
  .regex(/[0-9]/)
  .refine((s) => Buffer.byteLength(s, "utf8") <= 72);
const staffSchema = z.object({
  id: idSchema.optional(),
  name: text(40),
  phone: z
    .string()
    .trim()
    .regex(/^1[3-9]\d{9}$/),
  email: z
    .string()
    .trim()
    .email()
    .max(160)
    .transform((s) => s.toLowerCase()),
  password: password.optional(),
  job: z.enum(["DISPATCH", "MAINTENANCE", "BOTH"]),
  status: z.enum(["ACTIVE", "OFF_DUTY"]),
});
async function transaction(pool, user, work) {
  try {
    return await actorTransaction(pool, user, work);
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY")
      throw new AppError("名称、编号、邮箱或手机号已存在", "DUPLICATE", 409);
    throw error;
  }
}
const zoneBikeErrors = {
  ZONE_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
  BIKE_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
  ZONE_CAPACITY_TOO_SMALL: [
    "停车区容量不能小于占用及预留车位",
    "ZONE_FULL",
    409,
  ],
  ZONE_IN_USE: [
    "停车区有车辆或调度任务，不能关闭或移动围栏",
    "INVALID_STATE",
    409,
  ],
  ZONE_ACTIVE_RIDE: [
    "该停车区有未结束骑行，不能移动围栏",
    "INVALID_STATE",
    409,
  ],
  BIKE_ACTIVE: ["骑行、维修或调度中的车辆不能编辑", "INVALID_STATE", 409],
  BIKE_TARGET_CLOSED: ["车辆必须投放到开放停车区", "INVALID_STATE", 409],
  BIKE_TARGET_FULL: ["目标停车区已满或车位已预留", "ZONE_FULL", 409],
};
export async function saveZone(pool, user, input) {
  requireAdmin(user);
  const data = zoneSchema.parse(input);
  return transaction(pool, user, (connection) =>
    callProcedure(
      connection,
      "CALL sp_save_zone(?,?)",
      [user.id, JSON.stringify(data)],
      zoneBikeErrors,
    ),
  );
}
export async function saveBike(pool, user, input) {
  requireAdmin(user);
  const data = bikeSchema.parse(input);
  return transaction(pool, user, (connection) =>
    callProcedure(
      connection,
      "CALL sp_save_bike(?,?)",
      [user.id, JSON.stringify(data)],
      zoneBikeErrors,
    ),
  );
}
export async function saveStaff(pool, user, input) {
  requireAdmin(user);
  const d = staffSchema.parse(input);
  need(d.id || d.password, "新建员工须设置密码", "INVALID_INPUT", 400);
  const hash = d.password ? await bcrypt.hash(d.password, 10) : null;
  const staffData = {
    id: d.id,
    name: d.name,
    phone: d.phone,
    email: d.email,
    job: d.job,
    status: d.status,
  };
  return transaction(pool, user, (connection) =>
    callProcedure(
      connection,
      "CALL sp_save_staff(?,?,?)",
      [user.id, JSON.stringify(staffData), hash],
      {
        STAFF_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
        STAFF_ROLE_INVALID: [
          "只能编辑员工关联的运维账户",
          "INVALID_STATE",
          409,
        ],
        STAFF_BUSY: ["有未完成任务的员工不能离岗", "INVALID_STATE", 409],
        STAFF_DISPATCH_WORK: [
          "员工有调度任务，不能改为仅维修岗位",
          "INVALID_STATE",
          409,
        ],
        STAFF_MAINTENANCE_WORK: [
          "员工有维修工单，不能改为仅调度岗位",
          "INVALID_STATE",
          409,
        ],
        STAFF_USER_COLLISION: [
          "邮箱或手机号已注册；不可借员工创建提升现有账户权限",
          "DUPLICATE",
          409,
        ],
      },
    ),
  );
}
export async function setUserStatus(pool, user, id, input) {
  requireAdmin(user);
  const status = z
    .object({ status: z.enum(["ACTIVE", "SUSPENDED"]) })
    .parse(input).status;
  id = idSchema.parse(id);
  return transaction(pool, user, async (connection) => {
    await callProcedure(
      connection,
      "CALL sp_set_user_status(?,?,?)",
      [user.id, id, status],
      {
        USER_NOT_FOUND: ["记录不存在", "NOT_FOUND", 404],
        USER_SELF_SUSPEND: ["管理员不能停用自己的账户", "INVALID_STATE", 409],
        USER_ACTIVE_ORDERS: [
          "账户存在骑行或未支付订单，须先结束并支付",
          "INVALID_STATE",
          409,
        ],
        USER_ACTIVE_WORK: [
          "账户有已分配的未完成任务，不能停用",
          "INVALID_STATE",
          409,
        ],
      },
    );
    return { ok: true };
  });
}
