import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { createPool } from "../server/db.mjs";
import { applySchema } from "../scripts/sql.mjs";
import * as business from "../server/business.mjs";
import {
  createDispatchSuggestions,
  confirmDispatchSuggestion,
} from "../server/operations.mjs";
import { refreshRiskAlerts, actOnRisk } from "../server/risks.mjs";
import { reviewReturnAttempt } from "../server/returns.mjs";
import { reviewOrderQualification, adjustCarbon } from "../server/carbon.mjs";
import { updateLeaderboardProfile } from "../server/profile.mjs";

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
     ('carbon',JSON_OBJECT('kg_per_km',0.21,'points_per_km',10,'rule_version','carbon-v1')),
     ('risk',JSON_OBJECT('rule_version','risk-v1'))`,
  );
});
after(() => pool.end());

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

test("risk rule produces a versioned alert and operator can link a ticket", async () => {
  await pool.query(
    "INSERT INTO maintenance_tickets(bike_id,reporter_id,fault_type,description) VALUES(1,2,'BRAKE','近期刹车异常')",
  );
  const refreshed = await refreshRiskAlerts(pool, admin);
  assert.ok(refreshed.created.length > 0);
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
