import { z } from "zod";
import bcrypt from "bcryptjs";
import { AppError, actorTransaction } from "./db.mjs";
import { requireAdmin, audit, idSchema } from "./business.mjs";
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
  radius: z.number().finite().positive().max(2000),
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
async function row(c, table, id) {
  const [[r]] = await c.query(
    "SELECT * FROM " + table + " WHERE id=? FOR UPDATE",
    [idSchema.parse(id)],
  );
  need(r, "记录不存在", "NOT_FOUND", 404);
  return r;
}
async function inventory(c, id) {
  await row(c, "parking_zones", id);
  const [[r]] = await c.query("SELECT * FROM v_zone_inventory WHERE id=?", [
    id,
  ]);
  return r;
}
async function transaction(pool, user, work) {
  try {
    return await actorTransaction(pool, user, work);
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY")
      throw new AppError("名称、编号、邮箱或手机号已存在", "DUPLICATE", 409);
    throw error;
  }
}
async function staffWork(c, id) {
  const [[dispatch]] = await c.query(
    "SELECT COUNT(*) n FROM dispatch_tasks WHERE staff_id=? AND status IN ('PENDING','IN_PROGRESS')",
    [id],
  );
  const [[maintenance]] = await c.query(
    "SELECT COUNT(*) n FROM maintenance_tickets WHERE staff_id=? AND status<>'COMPLETED'",
    [id],
  );
  return { dispatch: Number(dispatch.n), maintenance: Number(maintenance.n) };
}
export async function saveZone(pool, user, input) {
  requireAdmin(user);
  const d = zoneSchema.parse(input);
  return transaction(pool, user, async (c) => {
    let id = d.id;
    if (id) {
      const old = await inventory(c, id),
        occupied = Number(old.occupied),
        reserved = Number(old.reserved);
      need(
        d.capacity >= occupied + reserved,
        "停车区容量不能小于占用及预留车位",
        "ZONE_FULL",
      );
      const [[tasks]] = await c.query(
        "SELECT COUNT(*) n FROM dispatch_tasks WHERE (source_zone_id=? OR target_zone_id=?) AND status IN ('PENDING','IN_PROGRESS')",
        [id, id],
      );
      const coordinatesChanged = Number(old.x) !== d.x || Number(old.y) !== d.y;
      const geometryChanged =
        coordinatesChanged || Number(old.radius) !== d.radius;
      if (geometryChanged || d.status === "CLOSED")
        need(
          occupied === 0 && reserved === 0 && Number(tasks.n) === 0,
          "停车区有车辆或调度任务，不能关闭或移动围栏",
        );
      if (geometryChanged) {
        const [[running]] = await c.query(
          "SELECT COUNT(*) n FROM ride_orders WHERE start_zone_id=? AND status='RUNNING'",
          [id],
        );
        need(Number(running.n) === 0, "该停车区有未结束骑行，不能移动围栏");
      }
      await c.query(
        "UPDATE parking_zones SET name=?,location=?,x=?,y=?,radius=?,capacity=?,status=? WHERE id=?",
        [d.name, d.location, d.x, d.y, d.radius, d.capacity, d.status, id],
      );
      await c.query("UPDATE road_nodes SET name=?,x=?,y=? WHERE zone_id=?", [
        d.name,
        d.x,
        d.y,
        id,
      ]);
      if (coordinatesChanged)
        await c.query(
          "UPDATE road_edges e JOIN road_nodes a ON a.id=e.from_node_id JOIN road_nodes b ON b.id=e.to_node_id SET e.distance_m=GREATEST(1,ROUND(SQRT(POW(a.x-b.x,2)+POW(a.y-b.y,2)))) WHERE a.zone_id=? OR b.zone_id=?",
          [id, id],
        );
    } else {
      const [nodes] = await c.query(
        "SELECT * FROM road_nodes ORDER BY id FOR UPDATE",
      );
      const [result] = await c.query(
        "INSERT INTO parking_zones(name,location,x,y,radius,capacity,status) VALUES(?,?,?,?,?,?,?)",
        [d.name, d.location, d.x, d.y, d.radius, d.capacity, d.status],
      );
      id = result.insertId;
      const [node] = await c.query(
        "INSERT INTO road_nodes(name,x,y,zone_id) VALUES(?,?,?,?)",
        [d.name, d.x, d.y, id],
      );
      if (nodes.length) {
        nodes.sort(
          (a, b) =>
            Math.hypot(Number(a.x) - d.x, Number(a.y) - d.y) -
              Math.hypot(Number(b.x) - d.x, Number(b.y) - d.y) || a.id - b.id,
        );
        const nearest = nodes[0];
        await c.query(
          "INSERT INTO road_edges(from_node_id,to_node_id,distance_m,safety_cost,comfort_cost) VALUES(?,?,?,?,?)",
          [
            Math.min(nearest.id, node.insertId),
            Math.max(nearest.id, node.insertId),
            Math.max(
              1,
              Math.round(
                Math.hypot(Number(nearest.x) - d.x, Number(nearest.y) - d.y),
              ),
            ),
            1,
            1,
          ],
        );
      }
    }
    await audit(
      c,
      user,
      d.id ? "ZONE_UPDATE" : "ZONE_CREATE",
      "parking_zones",
      id,
      d,
    );
    return { id };
  });
}
export async function saveBike(pool, user, input) {
  requireAdmin(user);
  const d = bikeSchema.parse(input);
  return transaction(pool, user, async (c) => {
    const old = d.id ? await row(c, "bikes", d.id) : null;
    if (old)
      need(
        ["AVAILABLE", "RETIRED"].includes(old.status),
        "骑行、维修或调度中的车辆不能编辑",
      );
    const status = d.status ?? old?.status ?? "AVAILABLE";
    const target = await inventory(c, d.zone_id);
    let current = null;
    if (status === "AVAILABLE") {
      need(target.status === "ACTIVE", "车辆必须投放到开放停车区");
      const already = old?.current_zone_id === target.id ? 1 : 0;
      need(
        Number(target.occupied) + Number(target.reserved) - already <
          Number(target.capacity),
        "目标停车区已满或车位已预留",
        "ZONE_FULL",
      );
      current = target.id;
    }
    const deployed =
      d.deployed_at ??
      (old
        ? new Date(old.deployed_at).toISOString().slice(0, 10)
        : new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10));
    let id = d.id;
    if (id)
      await c.query(
        "UPDATE bikes SET code=?,deployed_at=?,status=?,current_zone_id=? WHERE id=?",
        [d.code, deployed, status, current, id],
      );
    else {
      const [r] = await c.query(
        "INSERT INTO bikes(code,deployed_at,status,current_zone_id) VALUES(?,?,?,?)",
        [d.code, deployed, status, current],
      );
      id = r.insertId;
    }
    await audit(c, user, d.id ? "BIKE_UPDATE" : "BIKE_CREATE", "bikes", id, {
      code: d.code,
      status,
      zone_id: current,
      deployed_at: deployed,
    });
    return { id };
  });
}
export async function saveStaff(pool, user, input) {
  requireAdmin(user);
  const d = staffSchema.parse(input);
  need(d.id || d.password, "新建员工须设置密码", "INVALID_INPUT", 400);
  const hash = d.password ? await bcrypt.hash(d.password, 10) : null;
  return transaction(pool, user, async (c) => {
    let id = d.id,
      uid;
    if (id) {
      const old = await row(c, "staff", id),
        existing = await row(c, "users", old.user_id);
      need(existing.role === "OPERATOR", "只能编辑员工关联的运维账户");
      uid = old.user_id;
      const work = await staffWork(c, id);
      if (d.status === "OFF_DUTY")
        need(!work.dispatch && !work.maintenance, "有未完成任务的员工不能离岗");
      need(
        !work.dispatch || ["BOTH", "DISPATCH"].includes(d.job),
        "员工有调度任务，不能改为仅维修岗位",
      );
      need(
        !work.maintenance || ["BOTH", "MAINTENANCE"].includes(d.job),
        "员工有维修工单，不能改为仅调度岗位",
      );
      await c.query(
        "UPDATE users SET name=?,phone=?,email=?,role='OPERATOR' WHERE id=?",
        [d.name, d.phone, d.email, uid],
      );
      if (hash)
        await c.query("UPDATE users SET password_hash=? WHERE id=?", [
          hash,
          uid,
        ]);
      await c.query(
        "UPDATE staff SET name=?,phone=?,job=?,status=? WHERE id=?",
        [d.name, d.phone, d.job, d.status, id],
      );
    } else {
      const [[collision]] = await c.query(
        "SELECT id FROM users WHERE email=? OR phone=? FOR UPDATE",
        [d.email, d.phone],
      );
      need(
        !collision,
        "邮箱或手机号已注册；不可借员工创建提升现有账户权限",
        "DUPLICATE",
        409,
      );
      const [u] = await c.query(
        "INSERT INTO users(name,email,phone,password_hash,role) VALUES(?,?,?,?,'OPERATOR')",
        [d.name, d.email, d.phone, hash],
      );
      uid = u.insertId;
      const [s] = await c.query(
        "INSERT INTO staff(user_id,name,phone,job,status) VALUES(?,?,?,?,?)",
        [uid, d.name, d.phone, d.job, d.status],
      );
      id = s.insertId;
    }
    await audit(c, user, d.id ? "STAFF_UPDATE" : "STAFF_CREATE", "staff", id, {
      user_id: uid,
      name: d.name,
      email: d.email,
      phone: d.phone,
      job: d.job,
      status: d.status,
      password_changed: Boolean(hash),
    });
    return { id };
  });
}
export async function setUserStatus(pool, user, id, input) {
  requireAdmin(user);
  const status = z
    .object({ status: z.enum(["ACTIVE", "SUSPENDED"]) })
    .parse(input).status;
  id = idSchema.parse(id);
  return transaction(pool, user, async (c) => {
    await row(c, "users", id);
    if (status === "SUSPENDED") {
      need(id !== user.id, "管理员不能停用自己的账户");
      const [[rides]] = await c.query(
        "SELECT COUNT(*) n FROM ride_orders WHERE user_id=? AND status IN ('RUNNING','UNPAID')",
        [id],
      );
      need(Number(rides.n) === 0, "账户存在骑行或未支付订单，须先结束并支付");
      const [[staff]] = await c.query("SELECT id FROM staff WHERE user_id=?", [
        id,
      ]);
      if (staff) {
        const work = await staffWork(c, staff.id);
        need(
          !work.dispatch && !work.maintenance,
          "账户有已分配的未完成任务，不能停用",
        );
      }
    }
    await c.query("UPDATE users SET status=? WHERE id=?", [status, id]);
    await audit(c, user, "USER_STATUS", "users", id, { status });
    return { ok: true };
  });
}
