import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { createPool, ledgerTransaction } from "../backend/db.mjs";
import { applySchema } from "../scripts/sql.mjs";
import * as business from "../backend/business.mjs";
import { campusDefinition } from "../backend/campus-data.mjs";
const pool = createPool({
  database: "campus_bike_test",
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
const admin = { id: 1, role: "ADMIN" },
  user = { id: 2, role: "STUDENT" },
  other = { id: 4, role: "STUDENT" },
  operator = { id: 3, role: "OPERATOR" };
before(async () => {
  const [[{ name }]] = await pool.query("SELECT DATABASE() name");
  assert.equal(name, "campus_bike_test");
  await applySchema(pool);
});
beforeEach(async () => {
  const conn = await pool.getConnection();
  try {
    await conn.query("SET FOREIGN_KEY_CHECKS=0");
    const [tables] = await conn.query(
      "SELECT table_name name FROM information_schema.tables WHERE table_schema='campus_bike_test' AND table_type='BASE TABLE'",
    );
    for (const { name } of tables)
      await conn.query(`TRUNCATE TABLE \`${name}\``);
    await conn.query("SET FOREIGN_KEY_CHECKS=1");
  } finally {
    conn.release();
  }
  const hash = await bcrypt.hash("Qingxing2026!", 4);
  for (const [id, role] of [
    [1, "ADMIN"],
    [2, "STUDENT"],
    [3, "OPERATOR"],
    [4, "STUDENT"],
  ])
    await pool.query(
      "INSERT INTO users(id,name,email,phone,password_hash,role) VALUES(?,?,?,?,?,?)",
      [id, "测试" + id, `u${id}@test.local`, `1380000000${id}`, hash, role],
    );
  await pool.query(
    "INSERT INTO parking_zones(id,name,location,x,y,radius,capacity) VALUES(1,'源站','北',100,100,40,10),(2,'终点','南',500,100,40,3),(3,'满站','东',800,100,40,1)",
  );
  await pool.query(
    "INSERT INTO bikes(id,code,deployed_at,current_zone_id) VALUES(1,'QX01','2026-01-01',1),(2,'QX02','2026-01-01',1),(3,'QX03','2026-01-01',1),(4,'QX04','2026-01-01',3)",
  );
  await pool.query("INSERT INTO staff(id,user_id,job) VALUES(1,3,'BOTH')");
  await pool.query(
    "INSERT INTO road_nodes(id,name,x,y,zone_id) SELECT id,name,x,y,id FROM parking_zones",
  );
  await pool.query(
    "INSERT INTO road_edges(from_node_id,to_node_id,distance_m) VALUES(1,2,400),(2,3,300)",
  );
});
after(() => pool.end());
test("concurrent borrowers cannot both acquire one bike", async () => {
  const results = await Promise.allSettled([
    business.startRide(pool, user, { bike_id: 1 }),
    business.startRide(pool, other, { bike_id: 1 }),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const [[r]] = await pool.query(
    "SELECT status,current_zone_id FROM bikes WHERE id=1",
  );
  assert.equal(r.status, "RIDING");
  assert.equal(r.current_zone_id, null);
});
test("one user cannot run two rides and failed start leaves second bike available", async () => {
  await business.startRide(pool, user, { bike_id: 1 });
  await assert.rejects(business.startRide(pool, user, { bike_id: 2 }));
  const [[r]] = await pool.query("SELECT status FROM bikes WHERE id=2");
  assert.equal(r.status, "AVAILABLE");
});
test("native ride start preserves errors and audit records", async () => {
  await assert.rejects(business.startRide(pool, user, { bike_id: 999 }), {
    code: "NOT_FOUND",
    status: 404,
  });
  await pool.query("UPDATE parking_zones SET status='CLOSED' WHERE id=1");
  await assert.rejects(business.startRide(pool, user, { bike_id: 1 }), {
    code: "INVALID_STATE",
    status: 409,
  });
  await pool.query("UPDATE parking_zones SET status='ACTIVE' WHERE id=1");
  const { id } = await business.startRide(pool, user, { bike_id: 1 });
  const [[record]] = await pool.query(
    "SELECT actor_id,action,entity_id,detail FROM audit_logs WHERE entity_id=? AND action='RIDE_START'",
    [id],
  );
  assert.equal(record.actor_id, user.id);
  assert.equal(
    (typeof record.detail === "string"
      ? JSON.parse(record.detail)
      : record.detail
    ).bike_id,
    1,
  );
  await assert.rejects(business.startRide(pool, other, { bike_id: 1 }), {
    code: "BIKE_UNAVAILABLE",
    status: 409,
  });
});
test("outside geofence rejection commits violation but leaves order running", async () => {
  const { id } = await business.startRide(pool, user, { bike_id: 1 });
  await assert.rejects(
    business.returnRide(pool, user, id, {
      zone_id: 2,
      x: 700,
      y: 100,
      route_mode: "shortest",
    }),
    { code: "OUTSIDE_FENCE" },
  );
  const [[r]] = await pool.query("SELECT status FROM ride_orders WHERE id=?", [
    id,
  ]);
  assert.equal(r.status, "RUNNING");
  const [[v]] = await pool.query(
    "SELECT COUNT(*) n FROM return_attempts WHERE order_id=?",
    [id],
  );
  assert.equal(v.n, 1);
});
test("representable datetime boundaries are retained in stale location evidence", async () => {
  const { id } = await business.startRide(pool, user, { bike_id: 1 });
  for (const captured_at of [
    "1000-01-01T08:00:00.000+08:00",
    "9999-12-31T23:59:59.999Z",
  ]) {
    await assert.rejects(
      business.returnRide(pool, user, id, {
        zone_id: 2,
        x: 500,
        y: 100,
        captured_at,
        location_source: "DEVICE_GPS",
      }),
      { code: "LOCATION_STALE" },
    );
  }
  const [rows] = await pool.query(
    "SELECT DATE_FORMAT(location_captured_at,'%Y-%m-%d %H:%i:%s.%f') captured FROM return_attempts WHERE order_id=? ORDER BY id",
    [id],
  );
  assert.deepEqual(
    rows.map((row) => row.captured),
    ["1000-01-01 00:00:00.000000", "9999-12-31 23:59:59.999000"],
  );
});
test("geofence decisions use the same precision as stored evidence", async () => {
  const { id } = await business.startRide(pool, user, { bike_id: 1 });
  await assert.rejects(
    business.returnRide(pool, user, id, { zone_id: 1, x: 140.006, y: 100 }),
    { code: "OUTSIDE_FENCE" },
  );
  const [[attempt]] = await pool.query(
    "SELECT x,y,reason FROM return_attempts WHERE order_id=?",
    [id],
  );
  assert.deepEqual(attempt, { x: 140.01, y: 100, reason: "OUTSIDE_FENCE" });
  await business.returnRide(pool, user, id, { zone_id: 1, x: 140.004, y: 100 });
  const [[order]] = await pool.query(
    "SELECT return_x,return_y,status FROM ride_orders WHERE id=?",
    [id],
  );
  assert.deepEqual(order, { return_x: 140, return_y: 100, status: "UNPAID" });
});
test("full station rejects return without losing bike", async () => {
  const { id } = await business.startRide(pool, user, { bike_id: 1 });
  await assert.rejects(
    business.returnRide(pool, user, id, { zone_id: 3, x: 800, y: 100 }),
    { code: "ZONE_FULL" },
  );
});
test("station-only simulated return records the selected station centre", async () => {
  const { id } = await business.startRide(pool, user, { bike_id: 1 });
  await business.returnRide(pool, user, id, {
    zone_id: 2,
    route_mode: "shortest",
    location_source: "MAP_SIMULATION",
  });
  const [[order]] = await pool.query(
    "SELECT end_zone_id,return_x,return_y,location_source,status FROM ride_orders WHERE id=?",
    [id],
  );
  assert.deepEqual(order, {
    end_zone_id: 2,
    return_x: 500,
    return_y: 100,
    location_source: "MAP_SIMULATION",
    status: "UNPAID",
  });
});
test("return computes server route and fee; duplicate payment gives one payment and credit", async () => {
  const { id } = await business.startRide(pool, user, { bike_id: 1 });
  const r = await business.returnRide(pool, user, id, {
    zone_id: 2,
    x: 500,
    y: 100,
    distance_m: 999999,
  });
  assert.equal(r.distance_m, 400);
  assert.equal(r.amount_cents, 100);
  const results = await Promise.all([
    business.payRide(pool, user, id, { idempotency_key: "first-request-0001" }),
    business.payRide(pool, user, id, { idempotency_key: "first-request-0001" }),
  ]);
  assert.equal(results.filter((x) => x.duplicate).length, 1);
  const [[c]] = await pool.query(
    "SELECT points,carbon_kg FROM carbon_ledger WHERE order_id=?",
    [id],
  );
  assert.equal(c.points, 4);
  assert.equal(Number(c.carbon_kg), 0.084);
  const [[p]] = await pool.query(
    "SELECT COUNT(*) n FROM payments WHERE order_id=?",
    [id],
  );
  assert.equal(p.n, 1);
});
test("native return charges each started half hour independently of division precision", async () => {
  const { id } = await business.startRide(pool, user, { bike_id: 1 });
  const connection = await pool.getConnection();
  const start = new Date("2026-10-01T00:00:00.000Z");
  try {
    await connection.beginTransaction();
    for (const precision of [0, 4, 12]) {
      await connection.query("SET SESSION div_precision_increment=?", [
        precision,
      ]);
      for (const [elapsedMs, expected] of [
        [0, 100],
        [1, 100],
        [1_799_999, 100],
        [1_800_000, 100],
        [1_800_001, 200],
        [3_599_999, 200],
        [3_600_000, 200],
        [3_600_001, 300],
      ]) {
        await connection.query("SAVEPOINT before_return");
        await connection.query(
          "UPDATE ride_orders SET started_at=? WHERE id=?",
          [start, id],
        );
        const end = new Date(start.getTime() + elapsedMs);
        const [result] = await connection.query(
          "CALL sp_finish_ride_return(?,?,?,?,?,?,?,?,?,?)",
          [
            user.id,
            id,
            2,
            500,
            100,
            end,
            "MAP_SIMULATION",
            "shortest",
            400,
            end,
          ],
        );
        assert.equal(
          result[0][0].amount_cents,
          expected,
          `precision=${precision}, elapsed=${elapsedMs}`,
        );
        const [[order]] = await connection.query(
          "SELECT status,amount_cents FROM ride_orders WHERE id=?",
          [id],
        );
        assert.deepEqual(order, { status: "UNPAID", amount_cents: expected });
        const [payment] = await connection.query("CALL sp_pay_ride(?,?,?)", [
          user.id,
          id,
          "boundary-fee",
        ]);
        assert.equal(payment[0][0].amount_cents, expected);
        await connection.query("ROLLBACK TO SAVEPOINT before_return");
      }
    }
  } finally {
    await connection.rollback();
    await connection.query("SET SESSION div_precision_increment=DEFAULT");
    connection.release();
  }
});
test("ownership enforced for return and payment even for admin", async () => {
  const { id } = await business.startRide(pool, user, { bike_id: 1 });
  await assert.rejects(
    business.returnRide(pool, admin, id, { zone_id: 2, x: 500, y: 100 }),
    { status: 403 },
  );
  await business.returnRide(pool, user, id, { zone_id: 2, x: 500, y: 100 });
  await assert.rejects(
    business.payRide(pool, other, id, { idempotency_key: "other-payment-00" }),
    { status: 403 },
  );
});
test("unpaid orders block further borrowing", async () => {
  const { id } = await business.startRide(pool, user, { bike_id: 1 });
  await business.returnRide(pool, user, id, { zone_id: 2, x: 500, y: 100 });
  await assert.rejects(business.startRide(pool, user, { bike_id: 2 }), {
    code: "UNPAID_ORDER",
  });
});
test("native dispatch rejects malformed bike lists and identifiers without writes", async () => {
  for (const bikes of [
    null,
    "null",
    "{}",
    "1",
    '"1"',
    "false",
    "[]",
    "[1.5]",
    "[1,1.5]",
    "[18446744073709551616]",
    "[true]",
    '["1"]',
    "[null]",
    "[{}]",
    "[0]",
    "[-1]",
    JSON.stringify(Array.from({ length: 101 }, () => 1)),
  ]) {
    await assert.rejects(
      pool.query("CALL sp_create_dispatch(?,?,?,?,?,?,?)", [
        admin.id,
        1,
        2,
        bikes,
        null,
        "{}",
        campusDefinition,
      ]),
      { sqlMessage: "INVALID_DISPATCH_INPUT" },
    );
  }
  await assert.rejects(
    pool.query("CALL sp_create_dispatch(?,?,?,?,?,?,?)", [
      admin.id,
      1,
      2,
      "[18446744073709551615]",
      null,
      "{}",
      campusDefinition,
    ]),
    { sqlMessage: "BIKE_NOT_FOUND" },
  );
  const [[state]] = await pool.query(
    "SELECT (SELECT COUNT(*) FROM dispatch_tasks) tasks,(SELECT COUNT(*) FROM dispatch_bikes) bikes,(SELECT COUNT(*) FROM audit_logs WHERE action='DISPATCH_CREATE') audits,(SELECT COUNT(*) FROM bikes WHERE status='DISPATCHING') dispatched",
  );
  assert.deepEqual(state, { tasks: 0, bikes: 0, audits: 0, dispatched: 0 });
  const task = await business.createDispatch(pool, admin, {
    source_zone_id: 1,
    target_zone_id: 2,
    bike_ids: [1],
  });
  const [[record]] = await pool.query(
    "SELECT COUNT(*) AS bikes FROM dispatch_bikes WHERE task_id=?",
    [task.id],
  );
  assert.equal(record.bikes, 1);
});

test("dispatch reserves vehicles and destination slots, progresses atomically", async () => {
  const { id } = await business.createDispatch(pool, admin, {
    source_zone_id: 1,
    target_zone_id: 2,
    bike_ids: [1, 2],
    staff_id: 1,
  });
  await assert.rejects(business.startRide(pool, user, { bike_id: 1 }));
  const [[v]] = await pool.query(
    "SELECT reserved FROM v_zone_inventory WHERE id=2",
  );
  assert.equal(Number(v.reserved), 2);
  await business.dispatchAction(pool, operator, id, "start", {});
  const [[b]] = await pool.query(
    "SELECT current_zone_id FROM bikes WHERE id=1",
  );
  assert.equal(b.current_zone_id, null);
  await business.dispatchAction(pool, operator, id, "complete", {});
  const [[c]] = await pool.query(
    "SELECT status,current_zone_id FROM bikes WHERE id=1",
  );
  assert.equal(c.status, "AVAILABLE");
  assert.equal(c.current_zone_id, 2);
  const [[snapshots]] = await pool.query(
    "SELECT inventory_created,inventory_started,inventory_completed FROM dispatch_tasks WHERE id=?",
    [id],
  );
  const parse = (value) =>
    typeof value === "string" ? JSON.parse(value) : value;
  const created = parse(snapshots.inventory_created),
    started = parse(snapshots.inventory_started),
    completed = parse(snapshots.inventory_completed);
  assert.equal(created.source.occupied, 3);
  assert.equal(created.target.reserved, 2);
  assert.equal(started.source.occupied, 1);
  assert.equal(started.target.reserved, 2);
  assert.equal(completed.target.occupied, 2);
  assert.equal(completed.target.reserved, 0);
  await assert.rejects(
    business.dispatchAction(pool, operator, id, "complete", {}),
  );
});
test("dispatch cannot overbook target or include duplicate bikes", async () => {
  await assert.rejects(
    business.createDispatch(pool, admin, {
      source_zone_id: 1,
      target_zone_id: 3,
      bike_ids: [1],
      staff_id: 1,
    }),
    { code: "ZONE_FULL" },
  );
  await assert.rejects(
    business.createDispatch(pool, admin, {
      source_zone_id: 1,
      target_zone_id: 2,
      bike_ids: [1, 1],
      staff_id: 1,
    }),
  );
  const [[b]] = await pool.query("SELECT status FROM bikes WHERE id=1");
  assert.equal(b.status, "AVAILABLE");
});
test("reserved destination cannot accept a return that would steal dispatch slot", async () => {
  await pool.query("UPDATE parking_zones SET capacity=2 WHERE id=2");
  await business.createDispatch(pool, admin, {
    source_zone_id: 1,
    target_zone_id: 2,
    bike_ids: [1, 2],
    staff_id: 1,
  });
  const { id } = await business.startRide(pool, user, { bike_id: 3 });
  await assert.rejects(
    business.returnRide(pool, user, id, { zone_id: 2, x: 500, y: 100 }),
    { code: "ZONE_FULL" },
  );
});
test("cancelling pending dispatch releases reservation and vehicles", async () => {
  const { id } = await business.createDispatch(pool, admin, {
    source_zone_id: 1,
    target_zone_id: 2,
    bike_ids: [1],
  });
  await business.dispatchAction(pool, admin, id, "cancel", {});
  const [[b]] = await pool.query(
    "SELECT status,current_zone_id FROM bikes WHERE id=1",
  );
  assert.equal(b.status, "AVAILABLE");
  assert.equal(b.current_zone_id, 1);
  const [[z]] = await pool.query(
    "SELECT reserved FROM v_zone_inventory WHERE id=2",
  );
  assert.equal(Number(z.reserved), 0);
});
test("report removes vehicle from lending, duplicate open ticket rejected, repair restores it", async () => {
  const { id } = await business.reportFault(pool, user, {
    bike_id: 1,
    fault_type: "BRAKE",
    description: "刹车失灵需要检查",
  });
  await assert.rejects(business.startRide(pool, user, { bike_id: 1 }));
  await assert.rejects(
    business.reportFault(pool, other, {
      bike_id: 1,
      fault_type: "BRAKE",
      description: "刹车故障",
    }),
  );
  await business.maintenanceAction(pool, admin, id, "assign", { staff_id: 1 });
  await business.maintenanceAction(pool, operator, id, "complete", {
    result: "更换刹车片并通过测试",
  });
  const [[b]] = await pool.query(
    "SELECT status,last_service_at FROM bikes WHERE id=1",
  );
  assert.equal(b.status, "AVAILABLE");
  assert.ok(b.last_service_at);
});
test("fault reported during own ride remains unavailable after return until repair", async () => {
  const { id } = await business.startRide(pool, user, { bike_id: 1 });
  await business.reportFault(pool, user, {
    bike_id: 1,
    fault_type: "TIRE",
    description: "发现轮胎漏气",
  });
  await business.returnRide(pool, user, id, { zone_id: 2, x: 500, y: 100 });
  const [[b]] = await pool.query("SELECT status FROM bikes WHERE id=1");
  assert.equal(b.status, "MAINTENANCE");
});
test("student cannot dispatch or assign repairs", async () => {
  await assert.rejects(
    business.createDispatch(pool, user, {
      source_zone_id: 1,
      target_zone_id: 2,
      bike_ids: [1],
    }),
    { status: 403 },
  );
  const { id } = await business.reportFault(pool, user, {
    bike_id: 1,
    fault_type: "LOCK",
    description: "锁无法打开",
  });
  await assert.rejects(
    business.maintenanceAction(pool, user, id, "assign", { staff_id: 1 }),
    { status: 403 },
  );
});
test("off-duty staff cannot be assigned tasks", async () => {
  await pool.query("UPDATE staff SET status='OFF_DUTY' WHERE id=1");
  await assert.rejects(
    business.createDispatch(pool, admin, {
      source_zone_id: 1,
      target_zone_id: 2,
      bike_ids: [1],
      staff_id: 1,
    }),
  );
});
test("invalid numeric coordinates are rejected without changing order", async () => {
  const { id } = await business.startRide(pool, user, { bike_id: 1 });
  await assert.rejects(
    business.returnRide(pool, user, id, { zone_id: 2, x: "wrong", y: 100 }),
  );
  await assert.rejects(
    business.returnRide(pool, user, id, { zone_id: 2, x: 1e200, y: 100 }),
  );
  await assert.rejects(
    business.returnRide(pool, user, id, { zone_id: 2, x: -1, y: 100 }),
    { code: "INVALID_LOCATION" },
  );
  const [[attempt]] = await pool.query(
    "SELECT reason,x FROM return_attempts WHERE order_id=?",
    [id],
  );
  assert.deepEqual(attempt, { reason: "INVALID_LOCATION", x: -1 });
  const [[order]] = await pool.query(
    "SELECT status FROM ride_orders WHERE id=?",
    [id],
  );
  assert.equal(order.status, "RUNNING");
});
test("suspended actor cannot execute a write queued before suspension committed", async () => {
  let ready, release;
  const entered = new Promise((r) => {
      ready = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  const suspension = ledgerTransaction(pool, async (c) => {
    ready();
    await gate;
    await c.query("UPDATE users SET status='SUSPENDED' WHERE id=2");
  });
  await entered;
  const queued = business.reportFault(pool, user, {
    bike_id: 1,
    fault_type: "LOCK",
    description: "账号停用前排队报修",
  });
  release();
  await suspension;
  await assert.rejects(queued, { status: 403 });
  const [[{ n }]] = await pool.query(
    "SELECT COUNT(*) n FROM maintenance_tickets",
  );
  assert.equal(n, 0);
});
test("carbon half-unit rounding follows exact decimal half-up rule", async () => {
  await pool.query(
    "UPDATE road_edges SET distance_m=875 WHERE from_node_id=1 AND to_node_id=2",
  );
  const { id } = await business.startRide(pool, user, { bike_id: 1 });
  await pool.query(
    "UPDATE ride_orders SET started_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE) WHERE id=?",
    [id],
  );
  await business.returnRide(pool, user, id, { zone_id: 2, x: 500, y: 100 });
  await business.payRide(pool, user, id, {
    idempotency_key: "rounding-regression",
  });
  const [[c]] = await pool.query(
    "SELECT carbon_kg,points FROM carbon_ledger WHERE order_id=?",
    [id],
  );
  assert.equal(c.carbon_kg, 0.1838);
  assert.equal(c.points, 8);
});
