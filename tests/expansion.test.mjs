import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { createPool } from "../backend/db.mjs";
import { applySchema } from "../scripts/sql.mjs";
import * as business from "../backend/business.mjs";
import {
  createDispatchSuggestions,
  listDispatchSuggestions,
  confirmDispatchSuggestion,
  dismissDispatchSuggestion,
} from "../backend/operations.mjs";
import { refreshRiskAlerts, actOnRisk } from "../backend/risks.mjs";
import { reviewReturnAttempt } from "../backend/returns.mjs";
import { reviewOrderQualification, adjustCarbon } from "../backend/carbon.mjs";
import { updateLeaderboardProfile } from "../backend/profile.mjs";
import { leaderboard } from "../backend/read-model.mjs";
import { buildLeaderboard } from "./leaderboard-reference.mjs";
import { bikeRisks } from "./risk-reference.mjs";
import { riskData } from "../backend/risk-data.mjs";
import { sql } from "../backend/sql-statements.mjs";

const pool = createPool({
  database: "campus_bike_test",
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
const admin = { id: 1, role: "ADMIN" },
  student = { id: 2, role: "STUDENT" },
  operator = { id: 3, role: "OPERATOR" };

before(async () => applySchema(pool));
beforeEach(async () => {
  const c = await pool.getConnection();
  try {
    await c.query("SET FOREIGN_KEY_CHECKS=0");
    const [tables] = await c.query(
      "SELECT table_name name FROM information_schema.tables WHERE table_schema='campus_bike_test' AND table_type='BASE TABLE'",
    );
    for (const { name } of tables) await c.query(`TRUNCATE TABLE \`${name}\``);
    await c.query("SET FOREIGN_KEY_CHECKS=1");
  } finally {
    c.release();
  }
  const hash = await bcrypt.hash("Qingxing2026!", 4);
  await pool.query(
    `INSERT INTO users(id,name,email,phone,password_hash,role,leaderboard_alias)
     VALUES(1,'管理员','admin@expand.local','13700000001',?,'ADMIN','管理员'),
            (2,'学生','student@expand.local','13700000002',?,'STUDENT','北航骑行者'),
            (3,'运维','operator@expand.local','13700000003',?,'OPERATOR','运维人员')`,
    [hash, hash, hash],
  );
  await pool.query(
    "INSERT INTO parking_zones(id,name,location,x,y,radius,capacity) VALUES(1,'富余站','北区',100,100,40,12),(2,'缺车站','南区',500,100,40,12)",
  );
  await pool.query(
    `INSERT INTO bikes(id,code,deployed_at,current_zone_id) VALUES
     (1,'EX-01','2026-01-01',1),(2,'EX-02','2026-01-01',1),(3,'EX-03','2026-01-01',1),
     (4,'EX-04','2026-01-01',1),(5,'EX-05','2026-01-01',1),(6,'EX-06','2026-01-01',1),
     (7,'EX-07','2026-01-01',1),(8,'EX-08','2026-01-01',1),(9,'EX-09','2026-01-01',2)`,
  );
  await pool.query(
    "INSERT INTO staff(id,user_id,name,phone,job) VALUES(1,3,'运维','13700000003','BOTH')",
  );
  await pool.query(
    "INSERT INTO road_nodes(id,name,x,y,zone_id) SELECT id,name,x,y,id FROM parking_zones",
  );
  await pool.query(
    "INSERT INTO road_edges(from_node_id,to_node_id,distance_m) VALUES(1,2,400)",
  );
  await pool.query(
    `INSERT INTO system_settings(name,value) VALUES
     ('carbon',JSON_OBJECT('kg_per_km',0.21,'points_per_km',10,'rule_version','carbon-v1'))`,
  );
});
after(() => pool.end());

test("SQL registration preserves the full user id in default aliases", async () => {
  await pool.query("ALTER TABLE users AUTO_INCREMENT=9999");
  const aliases = [];
  for (const index of [0, 1, 2]) {
    const [result] = await pool.query("CALL sp_register_user(?,?,?,?)", [
      "新学生",
      `student${index}@alias.local`,
      `1360000000${index}`,
      "test-hash",
    ]);
    aliases.push(result[0][0].leaderboard_alias);
  }
  assert.deepEqual(aliases, ["骑行者9999", "骑行者10000", "骑行者10001"]);
});

test("saved dispatch suggestions keep their basis and create a revalidated task", async () => {
  const generated = await createDispatchSuggestions(pool, admin, { days: 7 });
  assert.ok(generated.suggestions.length > 0);
  const suggestion = generated.suggestions[0];
  const task = await confirmDispatchSuggestion(pool, admin, suggestion.id, 1);
  assert.equal(task.suggestion_id, suggestion.id);
  const [[saved]] = await pool.query(
    "SELECT status,task_id,algorithm_version,source_available,desired_inventory FROM dispatch_suggestions WHERE id=?",
    [suggestion.id],
  );
  assert.equal(saved.status, "CONFIRMED");
  assert.equal(saved.task_id, task.id);
  assert.equal(saved.algorithm_version, "demand-balance-v1");
  assert.ok(saved.source_available > saved.desired_inventory);
});

test("large dispatch allocations are split into executable suggestions", async () => {
  await pool.query(
    "UPDATE parking_zones SET capacity=CASE id WHEN 1 THEN 500 ELSE 750 END",
  );
  await pool.query("UPDATE bikes SET current_zone_id=1 WHERE id=9");
  await pool.query(`INSERT INTO bikes(code,deployed_at,current_zone_id)
    WITH RECURSIVE n AS (SELECT 1 AS value UNION ALL SELECT value+1 FROM n WHERE value<441)
    SELECT CONCAT('BULK-',value),'2026-01-01',1 FROM n`);
  const generated = await createDispatchSuggestions(pool, admin, { days: 7 });
  assert.deepEqual(
    generated.suggestions.map((item) => item.quantity),
    [100, 100, 50],
  );
  for (const suggestion of generated.suggestions) {
    await confirmDispatchSuggestion(pool, admin, suggestion.id, 1);
  }
  const [[totals]] = await pool.query(
    "SELECT COUNT(DISTINCT task_id) tasks,COUNT(*) bikes FROM dispatch_bikes",
  );
  assert.deepEqual(totals, { tasks: 3, bikes: 250 });
});

test("saved dispatch suggestions remain reachable beyond the first page", async () => {
  await pool.query(`INSERT INTO dispatch_suggestions(source_zone_id,target_zone_id,quantity,source_available,target_occupied,target_capacity,target_reserved,borrow_count,return_count,desired_inventory,window_start,window_end,reason,algorithm_version,created_by)
    WITH RECURSIVE n AS (SELECT 1 AS value UNION ALL SELECT value+1 FROM n WHERE value<105)
    SELECT 1,2,1,8,1,12,0,0,0,5,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),'分页测试','demand-balance-v1',1 FROM n`);
  const first = await listDispatchSuggestions(pool);
  assert.equal(first.suggestions.length, 100);
  assert.equal(first.next_before, first.suggestions.at(-1).id);
  const second = await listDispatchSuggestions(pool, first.next_before);
  assert.equal(second.suggestions.length, 5);
  assert.equal(second.next_before, null);
  const ids = [...first.suggestions, ...second.suggestions].map(
    (row) => row.id,
  );
  assert.equal(new Set(ids).size, 105);
  assert.ok(ids.every((id, i) => i === 0 || ids[i - 1] > id));
});

test("old oversized dispatch suggestions become stale with an actionable reason", async () => {
  const generated = await createDispatchSuggestions(pool, admin, { days: 7 });
  const suggestion = generated.suggestions[0];
  await pool.query("UPDATE dispatch_suggestions SET quantity=101 WHERE id=?", [
    suggestion.id,
  ]);
  await assert.rejects(
    confirmDispatchSuggestion(pool, admin, suggestion.id, 1),
    { code: "SUGGESTION_STALE" },
  );
  const [[saved]] = await pool.query(
    "SELECT status,resolution_note,task_id FROM dispatch_suggestions WHERE id=?",
    [suggestion.id],
  );
  assert.equal(saved.status, "STALE");
  assert.match(saved.resolution_note, /重新生成/);
  assert.equal(saved.task_id, null);
});

test("stale dispatch suggestion is persisted without creating a task", async () => {
  const generated = await createDispatchSuggestions(pool, admin, { days: 7 });
  assert.ok(generated.suggestions.length > 0);
  const suggestion = generated.suggestions[0];
  await pool.query("UPDATE parking_zones SET status='CLOSED' WHERE id=?", [
    suggestion.target_zone_id,
  ]);
  await assert.rejects(
    confirmDispatchSuggestion(pool, admin, suggestion.id, 1),
    { code: "SUGGESTION_STALE" },
  );
  const [[state]] = await pool.query(
    "SELECT status,resolution_note,task_id FROM dispatch_suggestions WHERE id=?",
    [suggestion.id],
  );
  assert.equal(state.status, "STALE");
  assert.ok(state.resolution_note);
  assert.equal(state.task_id, null);
  const [[{ count }]] = await pool.query(
    "SELECT COUNT(*) count FROM dispatch_tasks",
  );
  assert.equal(count, 0);
});

test("dispatch suggestions can be dismissed with a recorded reason", async () => {
  const generated = await createDispatchSuggestions(pool, admin, { days: 7 });
  const suggestion = generated.suggestions[0];
  assert.ok(suggestion);
  const result = await dismissDispatchSuggestion(pool, admin, suggestion.id, {
    note: "现场车流已恢复",
  });
  assert.equal(result.status, "DISMISSED");
  const [[saved]] = await pool.query(
    "SELECT status,resolution_note,task_id FROM dispatch_suggestions WHERE id=?",
    [suggestion.id],
  );
  assert.deepEqual(saved, {
    status: "DISMISSED",
    resolution_note: "现场车流已恢复",
    task_id: null,
  });
  await assert.rejects(
    confirmDispatchSuggestion(pool, admin, suggestion.id, 1),
    { code: "SUGGESTION_NOT_OPEN" },
  );
  assert.throws(
    () =>
      dismissDispatchSuggestion(pool, student, suggestion.id, {
        note: "不能操作",
      }),
    { code: "FORBIDDEN" },
  );
});

test("risk rule produces a versioned alert and operator can link a ticket", async () => {
  await pool.query(
    "INSERT INTO maintenance_tickets(bike_id,reporter_id,fault_type,description) VALUES(1,2,'BRAKE','近期刹车异常')",
  );
  const refreshed = await refreshRiskAlerts(pool, admin);
  assert.ok(refreshed.created.length > 0);
  assert.deepEqual((await refreshRiskAlerts(pool, admin)).created, []);
  const [[risk]] = await pool.query(
    "SELECT * FROM risk_alerts WHERE bike_id=1 ORDER BY id DESC LIMIT 1",
  );
  assert.equal(risk.rule_version, "risk-v1");
  const handled = await actOnRisk(pool, operator, risk.id, "CREATE_TICKET", {
    note: "现场检查刹车与车锁部件",
  });
  assert.equal(handled.status, "ACKNOWLEDGED");
  assert.ok(handled.maintenance_ticket_id);
});

test("risk refresh retains candidates with no historical tickets", async () => {
  await pool.query(
    "UPDATE bikes SET last_service_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 100 DAY) WHERE id=3",
  );
  const result = await refreshRiskAlerts(pool, admin);
  assert.ok(result.created.length > 0);
  const [[row]] = await pool.query(
    "SELECT ticket_ids FROM risk_alerts WHERE bike_id=3",
  );
  assert.deepEqual(
    typeof row.ticket_ids === "string"
      ? JSON.parse(row.ticket_ids)
      : row.ticket_ids,
    [],
  );
  assert.deepEqual((await refreshRiskAlerts(pool, admin)).created, []);
});

test("risk refresh handles an entirely low-risk fleet", async () => {
  await pool.query("UPDATE bikes SET last_service_at=UTC_TIMESTAMP(3)");
  const result = await refreshRiskAlerts(pool, admin);
  assert.deepEqual(result.created, []);
  assert.equal(result.evaluated, 9);
});

test("SQL risk aggregation matches rule results and ordered ticket references", async () => {
  const now = new Date("2026-10-27T12:00:00Z");
  await pool.query(
    "UPDATE bikes SET last_service_at='2026-09-01 12:00:00' WHERE id=1",
  );
  await pool.query(`INSERT INTO maintenance_tickets(bike_id,reporter_id,staff_id,fault_type,description,status,result,created_at,completed_at) VALUES
    (1,2,1,'BRAKE','完成工单一','COMPLETED','已修复','2026-10-01 12:00:00','2026-10-02 12:00:00'),
    (1,2,1,'BRAKE','完成工单二','COMPLETED','已修复','2026-10-10 12:00:00','2026-10-11 12:00:00'),
    (1,2,1,'TIRE','轮胎工单一','COMPLETED','已修复','2026-10-12 12:00:00','2026-10-13 12:00:00'),
    (1,2,1,'TIRE','轮胎工单二','COMPLETED','已修复','2026-10-14 12:00:00','2026-10-15 12:00:00')`);
  await pool.query(
    "INSERT INTO maintenance_tickets(bike_id,reporter_id,fault_type,description,created_at) VALUES(1,2,'TIRE','近期工单','2026-10-20 12:00:00')",
  );
  await pool.query(`INSERT INTO maintenance_tickets(bike_id,reporter_id,staff_id,fault_type,description,status,result,created_at,completed_at) VALUES
    (1,2,1,'BRAKE','未来工单','COMPLETED','已修复','2026-10-29 12:00:00','2026-10-30 12:00:00'),
    (2,2,1,'BRAKE','退役车辆工单','COMPLETED','已修复','2026-10-01 12:00:00','2026-10-02 12:00:00')`);
  await pool.query("UPDATE bikes SET status='RETIRED' WHERE id=2");
  const [bikes] = await pool.query(
    "SELECT * FROM bikes WHERE status<>'RETIRED'",
  );
  const [tickets] = await pool.query(
    "SELECT * FROM maintenance_tickets ORDER BY id",
  );
  const actual = await riskData(pool, now);
  assert.deepEqual(actual.risks, bikeRisks(bikes, tickets, now));
  const expectedIds = tickets
    .filter((ticket) => ticket.bike_id === 1 && ticket.created_at <= now)
    .map((ticket) => ticket.id);
  const transferred = [];
  const observedPool = {
    async getConnection() {
      const connection = await pool.getConnection();
      return new Proxy(connection, {
        get(target, property) {
          if (property === "query")
            return async (...args) => {
              const result = await target.query(...args);
              if (args[0] === sql("new_risk_tickets"))
                transferred.push(result[0]);
              return result;
            };
          const value = target[property];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  const first = await refreshRiskAlerts(observedPool, admin, now);
  assert.equal(first.created.length, 1);
  assert.deepEqual(
    transferred[0].map((row) => row.id),
    expectedIds,
  );
  assert.deepEqual(
    (await refreshRiskAlerts(observedPool, admin, now)).created,
    [],
  );
  assert.deepEqual(transferred[1], []);
  const [[saved]] = await pool.query(
    "SELECT ticket_ids FROM risk_alerts WHERE bike_id=1",
  );
  const savedIds =
    typeof saved.ticket_ids === "string"
      ? JSON.parse(saved.ticket_ids)
      : saved.ticket_ids;
  assert.deepEqual(savedIds, expectedIds);
});

test("short abnormal rides appear as risk clues without changing the score", async () => {
  const now = new Date("2026-10-27T12:00:00Z");
  await pool.query(
    "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status) VALUES(2,1,1,2,'2026-10-27 11:59:30','2026-10-27 12:00:00',700,100,'UNPAID')",
  );
  const { risks } = await riskData(pool, now);
  const bike = risks.find((entry) => entry.bike_id === 1);
  assert.equal(bike.score, 20);
  assert.ok(
    bike.reason_details.some(
      (reason) =>
        reason.rule === "SHORT_RIDE" && reason.message.includes("不计分"),
    ),
  );
});

test("risk ticket creation preserves active ride and dispatch states", async () => {
  const ride = await business.startRide(pool, student, { bike_id: 1 });
  const [risk] = await pool.query(
    "INSERT INTO risk_alerts(bike_id,score,level,reasons,ticket_ids,fingerprint,rule_version,recommendation) VALUES(1,30,'MEDIUM',JSON_ARRAY(),JSON_ARRAY(),REPEAT('a',64),'risk-v1','请检查')",
  );
  const handled = await actOnRisk(
    pool,
    operator,
    risk.insertId,
    "CREATE_TICKET",
    { note: "检".repeat(500) },
  );
  assert.ok(handled.maintenance_ticket_id);
  assert.equal(
    (await pool.query("SELECT status FROM bikes WHERE id=1"))[0][0].status,
    "RIDING",
  );
  await business.returnRide(pool, student, ride.id, {
    zone_id: 2,
    x: 500,
    y: 100,
  });
  assert.equal(
    (await pool.query("SELECT status FROM bikes WHERE id=1"))[0][0].status,
    "MAINTENANCE",
  );
  const task = await business.createDispatch(pool, admin, {
    source_zone_id: 1,
    target_zone_id: 2,
    bike_ids: [2],
    staff_id: 1,
  });
  const [dispatchRisk] = await pool.query(
    "INSERT INTO risk_alerts(bike_id,score,level,reasons,ticket_ids,fingerprint,rule_version,recommendation) VALUES(2,30,'MEDIUM',JSON_ARRAY(),JSON_ARRAY(),REPEAT('b',64),'risk-v1','请检查')",
  );
  await assert.rejects(
    actOnRisk(pool, operator, dispatchRisk.insertId, "CREATE_TICKET", {
      note: "检查车锁",
    }),
    { code: "INVALID_STATE" },
  );
  assert.equal(
    (await pool.query("SELECT status FROM bikes WHERE id=2"))[0][0].status,
    "DISPATCHING",
  );
  assert.equal(
    (
      await pool.query("SELECT status FROM dispatch_tasks WHERE id=?", [
        task.id,
      ])
    )[0][0].status,
    "PENDING",
  );
});

test("stale location is rejected, retained and then reviewed", async () => {
  const ride = await business.startRide(pool, student, { bike_id: 1 });
  await assert.rejects(
    business.returnRide(pool, student, ride.id, {
      zone_id: 2,
      x: 500,
      y: 100,
      captured_at: new Date(Date.now() - 10 * 60000).toISOString(),
      location_source: "MAP_SIMULATION",
    }),
    { code: "LOCATION_STALE" },
  );
  const [[attempt]] = await pool.query(
    "SELECT * FROM return_attempts WHERE order_id=?",
    [ride.id],
  );
  assert.equal(attempt.reason, "LOCATION_STALE");
  assert.equal(attempt.review_status, "PENDING");
  const reviewed = await reviewReturnAttempt(pool, admin, attempt.id, {
    action: "RESOLVE",
    note: "已确认定位信息过期并完成提醒",
  });
  assert.equal(reviewed.review_status, "RESOLVED");
});

test("reviewed rides award versioned carbon and adjustments append signed rows", async () => {
  const [row] = await pool.query(
    `INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status,qualification_status,qualification_reason)
     VALUES(2,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),UTC_TIMESTAMP(3),1000,100,'UNPAID','UNDER_REVIEW','自动规则待复核')`,
  );
  await pool.query(
    "INSERT INTO payments(order_id,amount_cents,idempotency_key) VALUES(?,100,'expand-payment')",
    [row.insertId],
  );
  await pool.query("UPDATE ride_orders SET status='PAID' WHERE id=?", [
    row.insertId,
  ]);
  await reviewOrderQualification(pool, admin, row.insertId, {
    decision: "VALID",
    reason: "人工复核确认有效",
  });
  await adjustCarbon(pool, admin, {
    order_id: row.insertId,
    points_change: -2,
    carbon_kg_change: -0.01,
    reason: "课堂演示校正",
    idempotency_key: "expand-adjustment-1",
  });
  const [[totals]] = await pool.query(
    "SELECT COUNT(*) entries,SUM(points_change) points,SUM(carbon_kg_change) carbon FROM carbon_transactions WHERE order_id=?",
    [row.insertId],
  );
  assert.equal(totals.entries, 2);
  assert.equal(Number(totals.points), 8);
  assert.equal(Number(totals.carbon), 0.2);
});

test("carbon awards retain precise historical factors and validate their own rule", async () => {
  await pool.query(
    "UPDATE system_settings SET value=JSON_OBJECT('kg_per_km',0.21019,'points_per_km',12.345678,'rule_version','precise-v1') WHERE name='carbon'",
  );
  const [order] = await pool.query(
    "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status) VALUES(2,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),UTC_TIMESTAMP(3),1000,100,'UNPAID')",
  );
  await business.payRide(pool, student, order.insertId, {
    idempotency_key: "precise-payment",
  });
  const [[award]] = await pool.query(
    "SELECT points_change,carbon_kg_change,factor_kg_per_km,points_per_km FROM carbon_transactions WHERE order_id=?",
    [order.insertId],
  );
  assert.deepEqual(award, {
    points_change: 12,
    carbon_kg_change: 0.2102,
    factor_kg_per_km: 0.21019,
    points_per_km: 12.345678,
  });
  await pool.query(
    "UPDATE system_settings SET value=JSON_OBJECT('kg_per_km',0.3,'points_per_km',20,'rule_version','next-v1') WHERE name='carbon'",
  );
  const checks = await readFile(
    new URL("../database/invariant-checks.sql", import.meta.url),
    "utf8",
  );
  const teaching = await readFile(
    new URL("../database/queries.sql", import.meta.url),
    "utf8",
  );
  const q18 = teaching
    .split("-- Q18:")[1]
    .split("-- Q19:")[0]
    .replace(/^[^\n]*\n/, "");
  assert.equal(
    (await pool.query(checks))[0].find(
      (row) => row.name === "有效已支付订单恰有一条版本化积分发放",
    ).errors,
    0,
  );
  assert.deepEqual((await pool.query(q18))[0], []);
  await pool.query(
    "UPDATE carbon_transactions SET points_change=13 WHERE order_id=?",
    [order.insertId],
  );
  assert.equal(
    (await pool.query(checks))[0].find(
      (row) => row.name === "有效已支付订单恰有一条版本化积分发放",
    ).errors,
    1,
  );
  assert.equal((await pool.query(q18))[0].length, 1);
});

test("teaching hotspot query filters borrowing and return times independently", async () => {
  const connection = await pool.getConnection();
  try {
    await connection.query(
      "SET timestamp=UNIX_TIMESTAMP('2026-10-07 04:00:00')",
    );
    await connection.query(`INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,status) VALUES
      (2,1,1,2,'2026-10-05 22:59:00','2026-10-05 23:01:00','UNPAID'),
      (2,1,1,2,'2026-10-06 01:59:00','2026-10-06 02:01:00','UNPAID'),
      (2,1,1,2,'2026-10-07 23:00:00','2026-10-07 23:10:00','UNPAID')`);
    const teaching = await readFile(
      new URL("../database/queries.sql", import.meta.url),
      "utf8",
    );
    const q26 = teaching
      .split("-- Q26:")[1]
      .split("-- Q27:")[0]
      .replace(/^[^\n]*\n/, "");
    const [rows] = await connection.query(q26);
    assert.deepEqual(rows, [
      { name: "富余站", borrow_count: 1, return_count: 0 },
      { name: "缺车站", borrow_count: 0, return_count: 1 },
    ]);
  } finally {
    await connection.query("SET timestamp=0");
    connection.release();
  }
});

test("excluded historical award is reversed without failing invariant checks", async () => {
  const [order] = await pool.query(
    "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status) VALUES(2,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),UTC_TIMESTAMP(3),1000,100,'UNPAID')",
  );
  await business.payRide(pool, student, order.insertId, {
    idempotency_key: "exclude-payment",
  });
  await pool.query(
    "UPDATE ride_orders SET qualification_status='UNDER_REVIEW',qualification_reason='重新复核' WHERE id=?",
    [order.insertId],
  );
  await reviewOrderQualification(pool, admin, order.insertId, {
    decision: "EXCLUDED",
    reason: "人工复核排除",
  });
  const [rows] = await pool.query(
    await readFile(
      new URL("../database/invariant-checks.sql", import.meta.url),
      "utf8",
    ),
  );
  const awardCheck = rows.find(
    (row) => row.name === "有效已支付订单恰有一条版本化积分发放",
  );
  assert.equal(Number(awardCheck.errors), 0);
  const teaching = await readFile(
    new URL("../database/queries.sql", import.meta.url),
    "utf8",
  );
  const q18 = teaching
    .split("-- Q18:")[1]
    .split("-- Q19:")[0]
    .replace(/^[^\n]*\n/, "");
  assert.deepEqual((await pool.query(q18))[0], []);
  const [[net]] = await pool.query(
    "SELECT SUM(points_change) points,SUM(carbon_kg_change) carbon FROM carbon_transactions WHERE order_id=?",
    [order.insertId],
  );
  assert.equal(Number(net.points), 0);
  assert.equal(Number(net.carbon), 0);
  // Historical reversals retain their original keys after upgrading.
  await pool.query(
    "UPDATE carbon_transactions SET idempotency_key=CONCAT('exclude-',order_id) WHERE order_id=? AND entry_type='ADJUSTMENT'",
    [order.insertId],
  );
  const [legacyChecks] = await pool.query(
    await readFile(
      new URL("../database/invariant-checks.sql", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    Number(
      legacyChecks.find(
        (row) => row.name === "有效已支付订单恰有一条版本化积分发放",
      ).errors,
    ),
    0,
  );
  assert.deepEqual((await pool.query(q18))[0], []);
});

test("SQL payment keeps qualification and idempotency consistent despite manual keys", async () => {
  const [first] = await pool.query(
    "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status,qualification_status,qualification_reason) VALUES(2,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),UTC_TIMESTAMP(3),1000,100,'UNPAID','UNDER_REVIEW','待复核')",
  );
  const paid = await business.payRide(pool, student, first.insertId, {
    idempotency_key: "review-payment-1",
  });
  assert.deepEqual(paid.credit, { awarded: false, reason: "UNDER_REVIEW" });
  await reviewOrderQualification(pool, admin, first.insertId, {
    decision: "VALID",
    reason: "已核对行程",
  });
  const [second] = await pool.query(
    "INSERT INTO ride_orders(id,user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status) VALUES(1001,2,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),UTC_TIMESTAMP(3),1000,100,'UNPAID')",
  );
  await assert.rejects(
    business.payRide(pool, student, second.insertId, {
      idempotency_key: "review-payment-1",
    }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  const input = {
    order_id: first.insertId,
    points_change: 1,
    carbon_kg_change: -0.00005,
    reason: "测试重复键",
    idempotency_key: `award-${second.insertId}`,
  };
  await adjustCarbon(pool, admin, input);
  const payment = await business.payRide(pool, student, second.insertId, {
    idempotency_key: "review-payment-2",
  });
  assert.equal(payment.credit.awarded, true);
  assert.equal((await adjustCarbon(pool, admin, input)).duplicate, true);
  assert.equal(
    (
      await business.payRide(pool, student, second.insertId, {
        idempotency_key: "review-payment-2",
      })
    ).duplicate,
    true,
  );
  const [[state]] = await pool.query(
    "SELECT status,(SELECT COUNT(*) FROM payments WHERE order_id=?) payments FROM ride_orders WHERE id=?",
    [second.insertId, second.insertId],
  );
  assert.equal(state.status, "PAID");
  assert.equal(state.payments, 1);
  const [[award]] = await pool.query(
    "SELECT idempotency_key FROM carbon_transactions WHERE order_id=? AND entry_type='AWARD'",
    [second.insertId],
  );
  assert.equal(award.idempotency_key, `auto:award-${second.insertId}`);
  const [[adjustment]] = await pool.query(
    "SELECT carbon_kg_change FROM carbon_transactions WHERE order_id=? AND entry_type='ADJUSTMENT'",
    [first.insertId],
  );
  assert.equal(adjustment.carbon_kg_change, -0.0001);
});

test("automatic exclusion reversal does not collide with manual adjustment keys", async () => {
  await pool.query(
    "INSERT INTO ride_orders(id,user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status) VALUES(1001,2,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),UTC_TIMESTAMP(3),1000,100,'UNPAID')",
  );
  await business.payRide(pool, student, 1001, {
    idempotency_key: "collision-payment",
  });
  const input = {
    order_id: 1001,
    points_change: 1,
    carbon_kg_change: 0,
    reason: "人工调整",
    idempotency_key: "exclude-1001",
  };
  await adjustCarbon(pool, admin, input);
  await pool.query(
    "UPDATE ride_orders SET qualification_status='UNDER_REVIEW',qualification_reason='重新复核' WHERE id=1001",
  );
  await reviewOrderQualification(pool, admin, 1001, {
    decision: "EXCLUDED",
    reason: "人工复核排除",
  });
  assert.equal((await adjustCarbon(pool, admin, input)).duplicate, true);
  const [rows] = await pool.query(
    "SELECT idempotency_key,points_change FROM carbon_transactions WHERE order_id=1001 AND entry_type='ADJUSTMENT' ORDER BY id",
  );
  assert.deepEqual(
    rows.map((row) => [row.idempotency_key, row.points_change]),
    [
      ["exclude-1001", 1],
      ["auto:exclude-1001", -10],
    ],
  );
  const [checks] = await pool.query(
    await readFile(
      new URL("../database/invariant-checks.sql", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    Number(
      checks.find((row) => row.name === "有效已支付订单恰有一条版本化积分发放")
        .errors,
    ),
    0,
  );
  await assert.rejects(
    pool.query(
      "CALL sp_adjust_carbon(1,1001,1,0,'非法编号','auto:exclude-1001',JSON_OBJECT())",
    ),
    { sqlMessage: "INVALID_ADJUSTMENT" },
  );
});

test("carbon adjustments enforce account balances and exact idempotency", async () => {
  const orders = [];
  for (const distance of [1000, 400]) {
    const [row] = await pool.query(
      "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status) VALUES(2,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),UTC_TIMESTAMP(3),?,100,'UNPAID')",
      [distance],
    );
    orders.push(row.insertId);
    await business.payRide(pool, student, row.insertId, {
      idempotency_key: `balance-pay-${row.insertId}`,
    });
  }
  const input = {
    order_id: orders[1],
    points_change: -12,
    carbon_kg_change: -0.25,
    reason: "余额校正",
    idempotency_key: "balance-adjust-1",
  };
  const [first, repeated] = await Promise.all([
    adjustCarbon(pool, admin, input),
    adjustCarbon(pool, admin, input),
  ]);
  assert.deepEqual([first.duplicate, repeated.duplicate].sort(), [false, true]);
  assert.equal(first.id, repeated.id);
  for (const changed of [
    { order_id: orders[0] },
    { points_change: -11 },
    { reason: "不同原因" },
  ]) {
    await assert.rejects(adjustCarbon(pool, admin, { ...input, ...changed }), {
      code: "IDEMPOTENCY_CONFLICT",
    });
  }
  await assert.rejects(
    adjustCarbon(pool, admin, {
      ...input,
      idempotency_key: "balance-over-points",
      points_change: -3,
      carbon_kg_change: 0,
    }),
    { code: "INSUFFICIENT_BALANCE" },
  );
  await assert.rejects(
    adjustCarbon(pool, admin, {
      ...input,
      idempotency_key: "balance-over-carbon",
      points_change: 0,
      carbon_kg_change: -0.0441,
    }),
    { code: "INSUFFICIENT_BALANCE" },
  );
  await assert.rejects(
    adjustCarbon(pool, admin, {
      ...input,
      idempotency_key: "balance-rounds-zero",
      points_change: 0,
      carbon_kg_change: 0.00001,
    }),
    { code: "INVALID_ADJUSTMENT" },
  );
  const [[balance]] = await pool.query(
    "SELECT points,carbon_kg FROM v_user_carbon WHERE user_id=2",
  );
  assert.equal(Number(balance.points), 2);
  assert.equal(Number(balance.carbon_kg), 0.044);
  const [[counts]] = await pool.query(
    "SELECT (SELECT COUNT(*) FROM carbon_transactions WHERE entry_type='ADJUSTMENT') entries,(SELECT COUNT(*) FROM audit_logs WHERE action='CARBON_ADJUST') audits",
  );
  assert.equal(counts.entries, 1);
  assert.equal(counts.audits, 1);
});

test("leaderboard counts current adjustments for qualifying old rides", async () => {
  const [order] = await pool.query(
    "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status) VALUES(2,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 65 DAY),DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 64 DAY),1000,100,'UNPAID')",
  );
  await pool.query(
    "INSERT INTO payments(order_id,amount_cents,idempotency_key) VALUES(?,100,'old-ride-payment')",
    [order.insertId],
  );
  await pool.query("UPDATE ride_orders SET status='PAID' WHERE id=?", [
    order.insertId,
  ]);
  await adjustCarbon(pool, admin, {
    order_id: order.insertId,
    points_change: 3,
    carbon_kg_change: 0.01,
    reason: "旧订单更正",
    idempotency_key: "old-ride-adjust",
  });
  const result = await leaderboard(pool, "month", "points", student.id);
  assert.equal(result.me.points, 3);
  assert.equal(result.me.rides, 0);
  assert.equal(result.me.private, true);
  assert.deepEqual(result.rows, []);
  const [users] = await pool.query("SELECT * FROM users");
  const [rides] = await pool.query("SELECT * FROM ride_orders");
  const [entries] = await pool.query("SELECT * FROM carbon_transactions");
  const reference = buildLeaderboard(
    users,
    rides,
    entries,
    "month",
    "points",
    new Date(result.window.end),
    student.id,
  );
  assert.deepEqual(result, reference);
});

test("a rider without eligible activity sees a private unranked summary", async () => {
  let board = await leaderboard(pool, "week", "points", student.id);
  assert.deepEqual(board.rows, []);
  assert.equal(board.me.rank, null);
  assert.equal(board.me.points, 0);
  assert.equal(board.me.rides, 0);
  assert.equal(board.me.private, true);
  await updateLeaderboardProfile(pool, student, {
    alias: "航空蓝骑手",
    visible: true,
  });
  board = await leaderboard(pool, "week", "points", student.id);
  assert.equal(board.me.rank, null);
  assert.equal(board.me.private, false);
  assert.deepEqual(board.rows, []);
});

test("leaderboard participation is explicit and audited", async () => {
  const profile = await updateLeaderboardProfile(pool, student, {
    alias: "航空蓝骑手",
    visible: true,
  });
  assert.equal(profile.leaderboard_alias, "航空蓝骑手");
  assert.equal(profile.leaderboard_visible, true);
  const [[user]] = await pool.query(
    "SELECT leaderboard_alias,leaderboard_visible FROM users WHERE id=2",
  );
  assert.equal(user.leaderboard_visible, 1);
  const [[{ n }]] = await pool.query(
    "SELECT COUNT(*) n FROM audit_logs WHERE action='LEADERBOARD_PROFILE_UPDATE' AND actor_id=2",
  );
  assert.equal(n, 1);
});
