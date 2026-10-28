import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPool } from "../backend/db.mjs";
import { applyFeatureMigrations } from "../backend/feature-migrations.mjs";
import { applySchema } from "../scripts/sql.mjs";

test("suggestion task uniqueness migrates safely without discarding conflicting history", async () => {
  const database = `campus_bike_suggestion_index_${randomBytes(4).toString("hex")}`;
  const credentials = {
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  };
  const admin = createPool({ ...credentials, database: undefined });
  let pool,
    created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    created = true;
    pool = createPool({ ...credentials, database });
    await applySchema(pool);
    await pool.query(
      "INSERT INTO users(id,name,email,phone,password_hash) VALUES(1,'管理员','suggestion@test.local','13000000000','hash')",
    );
    await pool.query(
      "INSERT INTO parking_zones(id,name,location,x,y,radius,capacity) VALUES(1,'源','北',10,10,10,10),(2,'目标','南',20,20,10,10)",
    );
    await pool.query(
      "INSERT INTO dispatch_tasks(id,source_zone_id,target_zone_id) VALUES(1,1,2)",
    );
    await pool.query(
      "ALTER TABLE dispatch_suggestions ADD INDEX legacy_task_index(task_id), DROP INDEX uq_dispatch_suggestion_task",
    );
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',16) WHERE name='pdf_expansion'",
    );
    await pool.query(`INSERT INTO dispatch_suggestions(id,source_zone_id,target_zone_id,quantity,source_available,target_occupied,target_capacity,target_reserved,borrow_count,return_count,desired_inventory,window_start,window_end,reason,algorithm_version,status,task_id,created_by,resolved_at) VALUES
      (1,1,2,1,1,0,10,0,1,0,1,'2026-01-01','2026-01-02','测试一','v1','CONFIRMED',1,1,UTC_TIMESTAMP(3)),
      (2,1,2,1,1,0,10,0,1,0,1,'2026-01-01','2026-01-02','测试二','v1','CONFIRMED',1,1,UTC_TIMESTAMP(3))`);
    const original = (
      await pool.query("SELECT * FROM dispatch_suggestions ORDER BY id")
    )[0];
    const checks = await readFile(
      new URL("../database/invariant-checks.sql", import.meta.url),
      "utf8",
    );
    const [bad] = await pool.query(checks);
    assert.equal(
      Number(
        bad.find((row) => row.name === "确认的调度建议唯一关联正式任务").errors,
      ),
      1,
    );
    await assert.rejects(applyFeatureMigrations(pool), {
      sqlMessage: "MIGRATION_DUPLICATE_SUGGESTION_TASKS",
    });
    assert.deepEqual(
      (await pool.query("SELECT * FROM dispatch_suggestions ORDER BY id"))[0],
      original,
    );
    const [[marker]] = await pool.query(
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(value,'$.version')) AS version FROM system_settings WHERE name='pdf_expansion'",
    );
    assert.equal(marker.version, "16");
    await pool.query(
      "UPDATE dispatch_suggestions SET status='DISMISSED',task_id=NULL WHERE id=2",
    );
    await pool.query(
      "ALTER TABLE dispatch_suggestions ADD INDEX uq_dispatch_suggestion_task(source_zone_id)",
    );
    await assert.rejects(applyFeatureMigrations(pool), {
      sqlMessage: "MIGRATION_SUGGESTION_TASK_INDEX_CONFLICT",
    });
    await pool.query(
      "ALTER TABLE dispatch_suggestions ADD INDEX legacy_source_index(source_zone_id), DROP INDEX uq_dispatch_suggestion_task",
    );
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, [
      "pdf_expansion@17",
    ]);
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
    const [index] = await pool.query(
      "SELECT column_name AS column_name,non_unique AS non_unique FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='dispatch_suggestions' AND index_name='uq_dispatch_suggestion_task'",
    );
    assert.deepEqual(index, [{ column_name: "task_id", non_unique: 0 }]);
    await assert.rejects(
      pool.query(
        "UPDATE dispatch_suggestions SET status='CONFIRMED',task_id=1 WHERE id=2",
      ),
      { code: "ER_DUP_ENTRY" },
    );
    await pool.query(`INSERT INTO dispatch_suggestions(source_zone_id,target_zone_id,quantity,source_available,target_occupied,target_capacity,target_reserved,borrow_count,return_count,desired_inventory,window_start,window_end,reason,algorithm_version,created_by)
      VALUES (1,2,1,1,0,10,0,1,0,1,'2026-01-01','2026-01-02','测试三','v1',1)`);
    const [[{ unlinked }]] = await pool.query(
      "SELECT COUNT(*) AS unlinked FROM dispatch_suggestions WHERE task_id IS NULL",
    );
    assert.equal(unlinked, 2);
    const [good] = await pool.query(checks);
    assert.equal(
      Number(
        good.find((row) => row.name === "确认的调度建议唯一关联正式任务")
          .errors,
      ),
      0,
    );
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

test("personal ride pagination index migrates safely from version 15", async () => {
  const database = `campus_bike_user_index_${randomBytes(4).toString("hex")}`;
  const credentials = {
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  };
  const admin = createPool({ ...credentials, database: undefined });
  let pool,
    created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    created = true;
    pool = createPool({ ...credentials, database });
    await applySchema(pool);
    await pool.query(
      "INSERT INTO users(id,name,email,phone,password_hash) VALUES(1,'学生','index@test.local','13000000000','hash')",
    );
    await pool.query(
      "INSERT INTO parking_zones(id,name,location,x,y,radius,capacity) VALUES(1,'测试站','测试',10,10,10,10)",
    );
    await pool.query(
      "INSERT INTO bikes(id,code,deployed_at,status) VALUES(1,'INDEX-TEST','2020-01-01','RIDING')",
    );
    await pool.query(
      "INSERT INTO ride_orders(id,user_id,bike_id,start_zone_id,status) VALUES(1,1,1,1,'RUNNING')",
    );
    const [originalOrders] = await pool.query("SELECT * FROM ride_orders");
    await pool.query("ALTER TABLE ride_orders DROP INDEX idx_ride_user_id");
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',15) WHERE name='pdf_expansion'",
    );
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, [
      "pdf_expansion@17",
    ]);
    const [index] = await pool.query(
      "SELECT column_name AS column_name,non_unique AS non_unique,collation AS collation,is_visible AS is_visible FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ride_orders' AND index_name='idx_ride_user_id' ORDER BY seq_in_index",
    );
    assert.deepEqual(index, [
      {
        column_name: "user_id",
        non_unique: 1,
        collation: "A",
        is_visible: "YES",
      },
      { column_name: "id", non_unique: 1, collation: "A", is_visible: "YES" },
    ]);
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
    const [[user]] = await pool.query("SELECT name FROM users WHERE id=1");
    assert.equal(user.name, "学生");
    assert.deepEqual(
      (await pool.query("SELECT * FROM ride_orders"))[0],
      originalOrders,
    );
    for (const definition of [
      "INDEX idx_ride_user_id(status,id)",
      "INDEX idx_ride_user_id(user_id,id DESC)",
      "INDEX idx_ride_user_id(user_id,id) INVISIBLE",
      "UNIQUE INDEX idx_ride_user_id(user_id,id)",
    ]) {
      await pool.query(
        `ALTER TABLE ride_orders DROP INDEX idx_ride_user_id, ADD ${definition}`,
      );
      await pool.query(
        "UPDATE system_settings SET value=JSON_OBJECT('version',15) WHERE name='pdf_expansion'",
      );
      await assert.rejects(applyFeatureMigrations(pool), {
        sqlMessage: "MIGRATION_RIDE_USER_INDEX_CONFLICT",
      });
      const [[marker]] = await pool.query(
        "SELECT JSON_UNQUOTE(JSON_EXTRACT(value,'$.version')) AS version FROM system_settings WHERE name='pdf_expansion'",
      );
      assert.equal(marker.version, "15");
    }
    await pool.query("ALTER TABLE ride_orders DROP INDEX idx_ride_user_id");
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, [
      "pdf_expansion@17",
    ]);
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

test("review queue index migrates safely from version 14 and can be retried", async () => {
  const database = `campus_bike_review_test_${randomBytes(4).toString("hex")}`;
  const credentials = {
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  };
  const admin = createPool({ ...credentials, database: undefined });
  let pool,
    created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    created = true;
    pool = createPool({ ...credentials, database });
    await applySchema(pool);
    await pool.query(
      "INSERT INTO users(id,name,email,phone,password_hash) VALUES(1,'学生','review-migration@test.local','13000000000','hash')",
    );
    await pool.query(
      "ALTER TABLE ride_orders DROP INDEX idx_ride_qualification",
    );
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',14) WHERE name='pdf_expansion'",
    );
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, [
      "pdf_expansion@17",
    ]);
    const [index] = await pool.query(
      "SELECT column_name AS column_name,non_unique AS non_unique FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ride_orders' AND index_name='idx_ride_qualification' ORDER BY seq_in_index",
    );
    assert.deepEqual(index, [
      { column_name: "qualification_status", non_unique: 1 },
    ]);
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
    const [[user]] = await pool.query("SELECT name FROM users WHERE id=1");
    assert.equal(user.name, "学生");
    await pool.query(
      "ALTER TABLE ride_orders DROP INDEX idx_ride_qualification, ADD INDEX idx_ride_qualification(status)",
    );
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',14) WHERE name='pdf_expansion'",
    );
    await assert.rejects(applyFeatureMigrations(pool), {
      sqlMessage: "MIGRATION_REVIEW_INDEX_CONFLICT",
    });
    const [[marker]] = await pool.query(
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(value,'$.version')) AS version FROM system_settings WHERE name='pdf_expansion'",
    );
    assert.equal(marker.version, "14");
    await pool.query(
      "ALTER TABLE ride_orders DROP INDEX idx_ride_qualification",
    );
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, [
      "pdf_expansion@17",
    ]);
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

test("feature migration preserves legacy rows and carbon totals and is idempotent", async () => {
  const admin = createPool({
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
    database: undefined,
  });
  const dbName = "campus_bike_migration_test";
  await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4`);
  const pool = createPool({
    database: dbName,
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  });
  try {
    await pool.query(
      "CREATE TABLE users(id BIGINT UNSIGNED PRIMARY KEY,name VARCHAR(40),email VARCHAR(160),phone VARCHAR(20),password_hash VARCHAR(100),role ENUM('STUDENT','ADMIN','OPERATOR') DEFAULT 'STUDENT',status ENUM('ACTIVE','SUSPENDED') DEFAULT 'ACTIVE',created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3))",
    );
    await pool.query(
      "CREATE TABLE staff(id BIGINT UNSIGNED PRIMARY KEY,user_id BIGINT UNSIGNED,name VARCHAR(40),phone VARCHAR(20),job VARCHAR(20),status VARCHAR(20))",
    );
    await pool.query(
      "CREATE TABLE parking_zones(id BIGINT UNSIGNED PRIMARY KEY,name VARCHAR(60),location VARCHAR(160),x DECIMAL(10,2),y DECIMAL(10,2),radius DECIMAL(8,2),capacity INT,status ENUM('ACTIVE','CLOSED') DEFAULT 'ACTIVE')",
    );
    await pool.query(
      "CREATE TABLE bikes(id BIGINT UNSIGNED PRIMARY KEY,code VARCHAR(30),deployed_at DATE,status ENUM('AVAILABLE','RIDING','MAINTENANCE','DISPATCHING','RETIRED') DEFAULT 'AVAILABLE',current_zone_id BIGINT UNSIGNED,last_service_at DATETIME(3))",
    );
    await pool.query(
      "CREATE TABLE ride_orders(id BIGINT UNSIGNED PRIMARY KEY,user_id BIGINT UNSIGNED,bike_id BIGINT UNSIGNED,start_zone_id BIGINT UNSIGNED,end_zone_id BIGINT UNSIGNED,started_at DATETIME(3),ended_at DATETIME(3),amount_cents INT,distance_m INT,distance_source ENUM('ROUTE_ESTIMATE') DEFAULT 'ROUTE_ESTIMATE',route_mode ENUM('shortest','safe','comfortable') DEFAULT 'shortest',status ENUM('RUNNING','UNPAID','PAID'))",
    );
    await pool.query(
      "CREATE TABLE payments(id BIGINT UNSIGNED PRIMARY KEY,order_id BIGINT UNSIGNED,idempotency_key VARCHAR(100),amount_cents INT,paid_at DATETIME(3),method ENUM('SIMULATED') DEFAULT 'SIMULATED')",
    );
    await pool.query(
      "CREATE TABLE dispatch_tasks(id BIGINT UNSIGNED PRIMARY KEY,source_zone_id BIGINT UNSIGNED,target_zone_id BIGINT UNSIGNED,status VARCHAR(20))",
    );
    await pool.query(
      "CREATE TABLE maintenance_tickets(id BIGINT UNSIGNED PRIMARY KEY,bike_id BIGINT UNSIGNED,reporter_id BIGINT UNSIGNED,fault_type VARCHAR(20),description VARCHAR(500),status VARCHAR(20),created_at DATETIME(3))",
    );
    await pool.query(
      "CREATE TABLE return_attempts(id BIGINT UNSIGNED PRIMARY KEY,order_id BIGINT UNSIGNED,zone_id BIGINT UNSIGNED,x DECIMAL(10,2),y DECIMAL(10,2),reason ENUM('OUTSIDE_FENCE','ZONE_FULL','ZONE_CLOSED'),created_at DATETIME(3))",
    );
    await pool.query(
      "CREATE TABLE road_nodes(id BIGINT UNSIGNED PRIMARY KEY,name VARCHAR(60),x DECIMAL(10,2),y DECIMAL(10,2),zone_id BIGINT UNSIGNED)",
    );
    await pool.query(
      "CREATE TABLE road_edges(id BIGINT UNSIGNED PRIMARY KEY,from_node_id BIGINT UNSIGNED,to_node_id BIGINT UNSIGNED,distance_m INT,safety_cost DECIMAL(6,2),comfort_cost DECIMAL(6,2))",
    );
    await pool.query(
      "CREATE TABLE carbon_ledger(id BIGINT UNSIGNED PRIMARY KEY,order_id BIGINT UNSIGNED,distance_m INT,points INT,carbon_kg DECIMAL(12,4),factor_kg_per_km DECIMAL(5,3),created_at DATETIME(3))",
    );
    await pool.query(
      "CREATE TABLE audit_logs(id BIGINT UNSIGNED PRIMARY KEY,actor_id BIGINT UNSIGNED,action VARCHAR(60),entity_type VARCHAR(40),entity_id BIGINT UNSIGNED,detail JSON,created_at DATETIME(3))",
    );
    await pool.query(
      "CREATE TABLE system_settings(name VARCHAR(50) PRIMARY KEY,value JSON)",
    );
    await pool.query(
      "INSERT INTO system_settings(name,value) VALUES('carbon',JSON_OBJECT('kg_per_km',0.33,'points_per_km',12,'rule_version','legacy-rule-v7','extra',JSON_OBJECT('source','history')))",
    );
    const [[originalRule]] = await pool.query(
      "SELECT value FROM system_settings WHERE name='carbon'",
    );
    await pool.query(
      "INSERT INTO users VALUES(1,'学生','s@test','13800000000','hash','STUDENT','ACTIVE',UTC_TIMESTAMP(3)),(10000,'学生二','s2@test','13800000001','hash','STUDENT','ACTIVE',UTC_TIMESTAMP(3)),(10001,'学生三','s3@test','13800000002','hash','STUDENT','ACTIVE',UTC_TIMESTAMP(3))",
    );
    await pool.query(
      "INSERT INTO parking_zones VALUES(1,'起点','北',100,100,40,10,'ACTIVE')",
    );
    await pool.query(
      "INSERT INTO bikes VALUES(1,'M-1','2026-01-01','AVAILABLE',1,NULL)",
    );
    await pool.query(
      "INSERT INTO ride_orders VALUES(1,1,1,1,1,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR),UTC_TIMESTAMP(3),100,500,'ROUTE_ESTIMATE','shortest','PAID')",
    );
    await pool.query(
      "INSERT INTO payments VALUES(1,1,'legacy-pay',100,UTC_TIMESTAMP(3),'SIMULATED')",
    );
    await pool.query(
      "INSERT INTO carbon_ledger VALUES(1,1,500,5,0.1050,0.210,UTC_TIMESTAMP(3))",
    );
    await pool.query(
      "INSERT INTO return_attempts VALUES(1,1,1,0,0,'OUTSIDE_FENCE',UTC_TIMESTAMP(3))",
    );
    await pool.query(
      "INSERT INTO road_nodes VALUES(1,'起点',100,100,1),(2,'路口',200,100,NULL)",
    );
    await pool.query("INSERT INTO road_edges VALUES(1,1,2,100,1,1)");
    await pool.query(
      "ALTER TABLE return_attempts ADD COLUMN location_captured_at DATETIME(3) NULL, ADD COLUMN location_source ENUM('MAP_SIMULATION','DEVICE_GPS','MANUAL','HISTORICAL_SIMULATION') NULL",
    );
    await pool.query(
      "UPDATE return_attempts SET location_captured_at='2024-01-01 01:02:03.123' WHERE id=1",
    );
    await pool.query(
      "INSERT INTO return_attempts(id,order_id,zone_id,x,y,reason,created_at,location_source) VALUES(2,1,1,0,0,'OUTSIDE_FENCE','2024-01-02 03:04:05.123','DEVICE_GPS')",
    );
    await pool.query(
      "INSERT INTO return_attempts(id,order_id,zone_id,x,y,reason,created_at,location_captured_at,location_source) VALUES(3,1,1,0,0,'OUTSIDE_FENCE','2024-01-03 12:00:00.000','2024-01-03 11:59:59.456','MANUAL')",
    );
    await pool.query(
      "ALTER TABLE road_edges ADD COLUMN slope_percent DECIMAL(5,2) NOT NULL DEFAULT 0, ADD COLUMN surface ENUM('SMOOTH','AVERAGE','ROUGH') NOT NULL DEFAULT 'SMOOTH', ADD COLUMN shade_level TINYINT UNSIGNED NOT NULL DEFAULT 3, ADD COLUMN lighting_level TINYINT UNSIGNED NOT NULL DEFAULT 3, ADD COLUMN traffic_mix ENUM('BIKE_ONLY','MIXED','MOTOR_HEAVY') NOT NULL DEFAULT 'MIXED', ADD COLUMN intersection_risk TINYINT UNSIGNED NOT NULL DEFAULT 1, ADD COLUMN attribute_source ENUM('SIMULATED_COURSE_DATA','MEASURED') NOT NULL DEFAULT 'SIMULATED_COURSE_DATA'",
    );
    await pool.query(
      "UPDATE road_edges SET slope_percent=7.25,surface='ROUGH',shade_level=5,lighting_level=2,traffic_mix='BIKE_ONLY',intersection_risk=4,attribute_source='MEASURED' WHERE id=1",
    );
    const [[originalEdge]] = await pool.query(
      "SELECT slope_percent,surface,shade_level,lighting_level,traffic_mix,intersection_risk,attribute_source FROM road_edges WHERE id=1",
    );

    await pool.query("UPDATE payments SET idempotency_key=NULL WHERE id=1");
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_INVALID_PAYMENT_KEYS/,
    );
    await pool.query(
      "UPDATE payments SET idempotency_key='legacy-pay' WHERE id=1",
    );
    await pool.query(
      "INSERT INTO staff VALUES(1,1,'旧姓名','13800000000','BOTH','ACTIVE')",
    );
    await assert.rejects(applyFeatureMigrations(pool), /STAFF_NAME_MISMATCH/);
    await pool.query("UPDATE staff SET name='学生',phone='旧电话' WHERE id=1");
    await assert.rejects(applyFeatureMigrations(pool), /STAFF_PHONE_MISMATCH/);
    await pool.query("UPDATE staff SET phone='13800000000' WHERE id=1");
    const first = await applyFeatureMigrations(pool);
    const second = await applyFeatureMigrations(pool);
    assert.ok(first.applied.length > 0);
    assert.deepEqual(second.applied, []);
    const [[migratedRule]] = await pool.query(
      "SELECT value FROM system_settings WHERE name='carbon'",
    );
    assert.deepEqual(migratedRule, originalRule);
    const [[migratedEdge]] = await pool.query(
      "SELECT slope_percent,surface,shade_level,lighting_level,traffic_mix,intersection_risk,attribute_source FROM road_edges WHERE id=1",
    );
    assert.deepEqual(migratedEdge, originalEdge);
    const [evidence] = await pool.query(
      "SELECT id,DATE_FORMAT(location_captured_at,'%Y-%m-%d %H:%i:%s.%f') captured,location_source FROM return_attempts ORDER BY id",
    );
    assert.deepEqual(evidence, [
      {
        id: 1,
        captured: "2024-01-01 01:02:03.123000",
        location_source: "HISTORICAL_SIMULATION",
      },
      {
        id: 2,
        captured: "2024-01-02 03:04:05.123000",
        location_source: "DEVICE_GPS",
      },
      {
        id: 3,
        captured: "2024-01-03 11:59:59.456000",
        location_source: "MANUAL",
      },
    ]);
    for (const [legacyRule, expected] of [
      [
        { kg_per_km: 0.42, points_per_km: 8, extra: "保留" },
        {
          kg_per_km: 0.42,
          points_per_km: 8,
          extra: "保留",
          rule_version: "carbon-v1",
        },
      ],
      [
        { kg_per_km: 0.42, points_per_km: 8, rule_version: null },
        { kg_per_km: 0.42, points_per_km: 8, rule_version: null },
      ],
      [null, { kg_per_km: 0.21, points_per_km: 10, rule_version: "carbon-v1" }],
    ]) {
      await pool.query("DELETE FROM system_settings WHERE name='carbon'");
      if (legacyRule !== null)
        await pool.query(
          "INSERT INTO system_settings(name,value) VALUES('carbon',?)",
          [JSON.stringify(legacyRule)],
        );
      await pool.query(
        "UPDATE system_settings SET value=JSON_OBJECT('version',0) WHERE name='pdf_expansion'",
      );
      assert.deepEqual((await applyFeatureMigrations(pool)).applied, [
        "pdf_expansion@17",
      ]);
      const [[actualRule]] = await pool.query(
        "SELECT value FROM system_settings WHERE name='carbon'",
      );
      assert.deepEqual(actualRule.value, expected);
    }
    await pool.query("UPDATE system_settings SET value=? WHERE name='carbon'", [
      JSON.stringify(originalRule.value),
    ]);
    const [historicalPayments] = await pool.query(
      "SELECT id,idempotency_key FROM payments ORDER BY id",
    );
    const [historicalCredits] = await pool.query(
      "SELECT id,idempotency_key FROM carbon_transactions ORDER BY id",
    );
    await pool.query(
      "ALTER TABLE payments MODIFY idempotency_key VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL",
    );
    await pool.query(
      "ALTER TABLE carbon_transactions MODIFY idempotency_key VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL",
    );
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',11) WHERE name='pdf_expansion'",
    );
    await pool.query(
      "UPDATE carbon_transactions SET idempotency_key=NULL WHERE id=?",
      [historicalCredits[0].id],
    );
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_INVALID_CARBON_KEYS/,
    );
    await pool.query(
      "UPDATE carbon_transactions SET idempotency_key=? WHERE id=?",
      [historicalCredits[0].idempotency_key, historicalCredits[0].id],
    );
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, [
      "pdf_expansion@17",
    ]);
    assert.deepEqual(
      (
        await pool.query("SELECT id,idempotency_key FROM payments ORDER BY id")
      )[0],
      historicalPayments,
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT id,idempotency_key FROM carbon_transactions ORDER BY id",
        )
      )[0],
      historicalCredits,
    );
    const [keyColumns] = await pool.query(
      "SELECT table_name AS table_name,collation_name AS collation_name,is_nullable AS is_nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('payments','carbon_transactions') AND column_name='idempotency_key' ORDER BY table_name",
    );
    assert.deepEqual(
      keyColumns.map((column) => [
        column.table_name,
        column.collation_name,
        column.is_nullable,
      ]),
      [
        ["carbon_transactions", "utf8mb4_0900_bin", "NO"],
        ["payments", "utf8mb4_0900_bin", "NO"],
      ],
    );
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
    await pool.query(
      "UPDATE ride_orders SET qualification_status='EXCLUDED',reviewed_by=1,reviewed_at=UTC_TIMESTAMP(3) WHERE id=1",
    );
    await pool.query(
      "CREATE OR REPLACE VIEW v_user_carbon AS SELECT u.id user_id,COALESCE(SUM(c.points_change),0) points,COALESCE(SUM(c.carbon_kg_change),0) carbon_kg,COALESCE(SUM(CASE WHEN c.entry_type='AWARD' THEN c.distance_m ELSE 0 END),0) distance_m FROM users u LEFT JOIN ride_orders r ON r.user_id=u.id LEFT JOIN carbon_transactions c ON c.order_id=r.id GROUP BY u.id",
    );
    const [[beforeViewUpgrade]] = await pool.query(
      "SELECT * FROM v_user_carbon WHERE user_id=1",
    );
    assert.equal(Number(beforeViewUpgrade.distance_m), 500);
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',12) WHERE name='pdf_expansion'",
    );
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, [
      "pdf_expansion@17",
    ]);
    const [[afterViewUpgrade]] = await pool.query(
      "SELECT * FROM v_user_carbon WHERE user_id=1",
    );
    assert.equal(Number(afterViewUpgrade.distance_m), 0);
    assert.equal(
      Number(afterViewUpgrade.points),
      Number(beforeViewUpgrade.points),
    );
    assert.equal(
      Number(afterViewUpgrade.carbon_kg),
      Number(beforeViewUpgrade.carbon_kg),
    );
    assert.deepEqual(
      (
        await pool.query("SELECT id,idempotency_key FROM payments ORDER BY id")
      )[0],
      historicalPayments,
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT id,idempotency_key FROM carbon_transactions ORDER BY id",
        )
      )[0],
      historicalCredits,
    );
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
    await pool.query(
      "UPDATE ride_orders SET qualification_status='VALID',reviewed_by=NULL,reviewed_at=NULL WHERE id=1",
    );
    const [staffColumns] = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='staff' AND column_name IN ('name','phone')",
    );
    assert.equal(staffColumns.length, 0);
    const [[staff]] = await pool.query(
      "SELECT s.id,u.name,u.phone FROM staff s JOIN users u ON u.id=s.user_id",
    );
    assert.deepEqual(staff, { id: 1, name: "学生", phone: "13800000000" });
    assert.equal(
      (await pool.query("SELECT COUNT(*) n FROM ride_orders"))[0][0].n,
      1,
    );
    const [[totals]] = await pool.query(
      "SELECT SUM(points_change) points,SUM(carbon_kg_change) carbon FROM carbon_transactions",
    );
    assert.deepEqual(totals, { points: 5, carbon: 0.105 });
    const [[user]] = await pool.query(
      "SELECT leaderboard_alias,leaderboard_visible FROM users WHERE id=1",
    );
    assert.equal(user.leaderboard_alias, "骑行者0001");
    assert.equal(user.leaderboard_visible, 0);
    const [largeIds] = await pool.query(
      "SELECT leaderboard_alias FROM users WHERE id IN (10000,10001) ORDER BY id",
    );
    assert.deepEqual(
      largeIds.map((row) => row.leaderboard_alias),
      ["骑行者10000", "骑行者10001"],
    );
    const [[order]] = await pool.query(
      "SELECT qualification_status FROM ride_orders WHERE id=1",
    );
    assert.equal(order.qualification_status, "VALID");
    const [[attempt]] = await pool.query(
      "SELECT review_status,location_source FROM return_attempts WHERE id=1",
    );
    assert.deepEqual(attempt, {
      review_status: "PENDING",
      location_source: "HISTORICAL_SIMULATION",
    });
    const [[edge]] = await pool.query(
      "SELECT direction,status,attribute_source FROM road_edges WHERE id=1",
    );
    assert.deepEqual(edge, {
      direction: "BOTH",
      status: "OPEN",
      attribute_source: "MEASURED",
    });
    // Version 1 installations need the constraints introduced in version 2.
    await pool.query("ALTER TABLE road_edges DROP CHECK chk_road_attributes");
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',1) WHERE name='pdf_expansion'",
    );
    assert.ok((await applyFeatureMigrations(pool)).applied.length > 0);
    const [[{ checks }]] = await pool.query(
      "SELECT COUNT(*) checks FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='road_edges' AND constraint_name='chk_road_attributes'",
    );
    assert.equal(checks, 1);
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
    // Upgrade an existing version 3 database without losing its data.
    await pool.query("ALTER TABLE ride_orders DROP INDEX idx_ride_user_status");
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',3) WHERE name='pdf_expansion'",
    );
    assert.ok((await applyFeatureMigrations(pool)).applied.length > 0);
    const [[{ indexes }]] = await pool.query(
      "SELECT COUNT(*) indexes FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ride_orders' AND index_name='idx_ride_user_status'",
    );
    assert.equal(indexes, 2);
    const [[{ target_indexes }]] = await pool.query(
      "SELECT COUNT(*) target_indexes FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='dispatch_tasks' AND index_name='idx_dispatch_target_status'",
    );
    assert.equal(target_indexes, 2);
    const [[{ inventory_columns }]] = await pool.query(
      "SELECT COUNT(*) inventory_columns FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='dispatch_tasks' AND column_name IN ('inventory_created','inventory_started','inventory_completed')",
    );
    assert.equal(inventory_columns, 3);
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
    // A version 8 ledger keeps historical values without inventing a rate.
    await pool.query(
      "ALTER TABLE carbon_transactions DROP COLUMN points_per_km, MODIFY factor_kg_per_km DECIMAL(5,3) NOT NULL DEFAULT 0.210",
    );
    await pool.query(
      "CREATE OR REPLACE VIEW carbon_ledger AS SELECT id,order_id,distance_m,points_change points,carbon_kg_change carbon_kg,factor_kg_per_km,created_at FROM carbon_transactions WHERE entry_type='AWARD'",
    );
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',8) WHERE name='pdf_expansion'",
    );
    assert.ok((await applyFeatureMigrations(pool)).applied.length > 0);
    const [[ledger]] = await pool.query(
      "SELECT points_change,carbon_kg_change,factor_kg_per_km,points_per_km FROM carbon_transactions WHERE id=1",
    );
    assert.deepEqual(ledger, {
      points_change: 5,
      carbon_kg_change: 0.105,
      factor_kg_per_km: 0.21,
      points_per_km: null,
    });
    const [[column]] = await pool.query(
      "SELECT numeric_precision AS numeric_precision,numeric_scale AS numeric_scale FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='carbon_ledger' AND column_name='factor_kg_per_km'",
    );
    assert.deepEqual(column, { numeric_precision: 20, numeric_scale: 8 });
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
    // Version 9 defaults depended on the MySQL session timezone.
    const [[beforeUtcUpgrade]] = await pool.query(
      "SELECT created_at FROM users WHERE id=1",
    );
    await pool.query(
      "ALTER TABLE users ALTER COLUMN created_at SET DEFAULT (CURRENT_TIMESTAMP(3))",
    );
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',9) WHERE name='pdf_expansion'",
    );
    assert.ok((await applyFeatureMigrations(pool)).applied.length > 0);
    const [[afterUtcUpgrade]] = await pool.query(
      "SELECT created_at FROM users WHERE id=1",
    );
    assert.deepEqual(afterUtcUpgrade, beforeUtcUpgrade);
    const [[utcDefault]] = await pool.query(
      "SELECT LOWER(column_default) AS value FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='created_at'",
    );
    assert.match(utcDefault.value, /utc_timestamp\(3\)/);
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.end();
  }
});

test("legacy carbon migration rejects equal-total rows with conflicting history", async () => {
  const database = `campus_bike_carbon_migration_${randomBytes(4).toString("hex")}`;
  const credentials = {
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  };
  const admin = createPool({ ...credentials, database: undefined });
  let pool,
    created = false;
  try {
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    pool = createPool({ ...credentials, database });
    await applySchema(pool);
    await pool.query(
      "INSERT INTO users(id,name,email,phone,password_hash) VALUES(1,'学生','legacy@test.local','13700000001','hash')",
    );
    await pool.query(
      "INSERT INTO parking_zones(id,name,location,x,y,radius,capacity) VALUES(1,'站点','校园',10,10,10,10)",
    );
    await pool.query(
      "INSERT INTO bikes(id,code,deployed_at,current_zone_id) VALUES(1,'LEGACY-1','2024-01-01',1)",
    );
    await pool.query(
      "INSERT INTO ride_orders(id,user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,amount_cents,distance_m,status) VALUES(1,1,1,1,1,'2024-01-01 00:00:00','2024-01-01 00:05:00',100,500,'UNPAID'),(2,1,1,1,1,'2024-01-02 00:00:00','2024-01-02 00:05:00',100,500,'UNPAID')",
    );
    await pool.query(
      "INSERT INTO payments(order_id,idempotency_key,amount_cents) VALUES(1,'payment-legacy-1',100),(2,'payment-legacy-2',100)",
    );
    await pool.query("UPDATE ride_orders SET status='PAID'");
    await pool.query(
      "INSERT INTO carbon_transactions(id,order_id,entry_type,idempotency_key,distance_m,points_change,carbon_kg_change,factor_kg_per_km,rule_version,reason,created_at) VALUES(1,1,'AWARD','historic-key',500,5,0.1050,0.210,'old-rule','已有记录','2024-01-01 01:00:00.000')",
    );
    await pool.query("DROP VIEW carbon_ledger");
    await pool.query(
      "CREATE TABLE carbon_ledger(id BIGINT UNSIGNED PRIMARY KEY,order_id BIGINT UNSIGNED,distance_m INT,points INT,carbon_kg DECIMAL(12,4),factor_kg_per_km DECIMAL(5,3),created_at DATETIME(3))",
    );
    await pool.query(
      "INSERT INTO carbon_ledger VALUES(1,2,500,5,0.1050,0.210,'2024-01-01 01:00:00.000')",
    );
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',0) WHERE name='pdf_expansion'",
    );
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_CARBON_CONFLICT/,
    );
    const [[old]] = await pool.query(
      "SELECT id,order_id,distance_m,points,carbon_kg FROM carbon_ledger",
    );
    assert.deepEqual(old, {
      id: 1,
      order_id: 2,
      distance_m: 500,
      points: 5,
      carbon_kg: 0.105,
    });
    const [[current]] = await pool.query(
      "SELECT id,order_id,idempotency_key,distance_m,points_change,carbon_kg_change FROM carbon_transactions",
    );
    assert.deepEqual(current, {
      id: 1,
      order_id: 1,
      idempotency_key: "historic-key",
      distance_m: 500,
      points_change: 5,
      carbon_kg_change: 0.105,
    });
    for (const mutation of [
      "order_id=1,distance_m=501,factor_kg_per_km=0.210,created_at='2024-01-01 01:00:00.000'",
      "order_id=1,distance_m=500,factor_kg_per_km=0.211,created_at='2024-01-01 01:00:00.000'",
      "order_id=1,distance_m=500,factor_kg_per_km=0.210,created_at='2024-01-01 01:00:00.001'",
    ]) {
      await pool.query(`UPDATE carbon_ledger SET ${mutation} WHERE id=1`);
      const [before] = await pool.query(
        "SELECT * FROM carbon_ledger ORDER BY id",
      );
      await assert.rejects(
        applyFeatureMigrations(pool),
        /MIGRATION_CARBON_CONFLICT/,
      );
      assert.deepEqual(
        (await pool.query("SELECT * FROM carbon_ledger ORDER BY id"))[0],
        before,
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT id,order_id,idempotency_key,distance_m,points_change,carbon_kg_change FROM carbon_transactions",
          )
        )[0][0],
        current,
      );
    }
    await pool.query(
      "UPDATE carbon_ledger SET order_id=1,distance_m=500,factor_kg_per_km=0.210,created_at='2024-01-01 01:00:00.000' WHERE id=1",
    );
    await pool.query("CREATE TABLE carbon_ledger_legacy LIKE carbon_ledger");
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_CARBON_LEGACY_COLLISION/,
    );
    await pool.query("DROP TABLE carbon_ledger_legacy");
    await pool.query(
      "INSERT INTO carbon_ledger VALUES(2,2,500,5,0.1050,0.210,'2024-01-02 01:00:00.000')",
    );
    await pool.query(
      "UPDATE carbon_transactions SET idempotency_key='legacy-award-2' WHERE id=1",
    );
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_CARBON_CONFLICT/,
    );
    await pool.query(
      "UPDATE carbon_transactions SET idempotency_key='historic-key' WHERE id=1",
    );
    await pool.query("UPDATE carbon_ledger SET order_id=1 WHERE id=2");
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_CARBON_CONFLICT/,
    );
    await pool.query(
      "UPDATE carbon_ledger SET order_id=2,distance_m=NULL WHERE id=2",
    );
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_CARBON_CONFLICT/,
    );
    await pool.query("UPDATE carbon_ledger SET distance_m=500 WHERE id=2");
    await pool.query("UPDATE ride_orders SET status='UNPAID' WHERE id=2");
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_CARBON_CONFLICT/,
    );
    await pool.query("UPDATE ride_orders SET status='PAID' WHERE id=2");
    await pool.query("UPDATE payments SET amount_cents=101 WHERE order_id=2");
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_CARBON_CONFLICT/,
    );
    await pool.query("UPDATE payments SET amount_cents=100 WHERE order_id=2");
    await pool.query("DELETE FROM payments WHERE order_id=2");
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_CARBON_CONFLICT/,
    );
    await pool.query("UPDATE ride_orders SET status='UNPAID' WHERE id=2");
    await pool.query(
      "INSERT INTO payments(order_id,idempotency_key,amount_cents) VALUES(2,'payment-legacy-2',100)",
    );
    await pool.query("UPDATE ride_orders SET status='PAID' WHERE id=2");
    const [[beforeRestore]] = await pool.query(
      "SELECT COUNT(*) AS n FROM carbon_transactions",
    );
    assert.equal(beforeRestore.n, 1);
    await pool.query("ALTER TABLE carbon_ledger MODIFY created_at DATETIME(6)");
    await pool.query(
      "UPDATE carbon_ledger SET created_at='2024-01-02 01:00:00.000001' WHERE id=2",
    );
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_CARBON_VERIFY_FAILED/,
    );
    const [[legacyStillPresent]] = await pool.query(
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='carbon_ledger' AND table_type='BASE TABLE'",
    );
    assert.equal(legacyStillPresent.n, 1);
    const [[legacyTime]] = await pool.query(
      "SELECT DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') AS value FROM carbon_ledger WHERE id=2",
    );
    assert.equal(legacyTime.value, "2024-01-02 01:00:00.000001");
    await pool.query(
      "UPDATE carbon_ledger SET created_at='2024-01-02 01:00:00.000000' WHERE id=2",
    );
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, [
      "pdf_expansion@17",
    ]);
    const [awards] = await pool.query(
      "SELECT id,order_id,idempotency_key,distance_m,points_change,carbon_kg_change,rule_version FROM carbon_transactions ORDER BY id",
    );
    assert.deepEqual(awards, [
      { ...current, rule_version: "old-rule" },
      {
        id: 2,
        order_id: 2,
        idempotency_key: "legacy-award-2",
        distance_m: 500,
        points_change: 5,
        carbon_kg_change: 0.105,
        rule_version: "legacy-v1",
      },
    ]);
    const [[legacyRows]] = await pool.query(
      "SELECT COUNT(*) AS n FROM carbon_ledger_legacy",
    );
    assert.equal(legacyRows.n, 2);
    const [[compatibilityView]] = await pool.query(
      "SELECT table_type AS kind FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='carbon_ledger'",
    );
    assert.equal(compatibilityView.kind, "VIEW");
    const [compatibilityRows] = await pool.query(
      "SELECT id,order_id,distance_m,points,carbon_kg FROM carbon_ledger ORDER BY id",
    );
    assert.deepEqual(compatibilityRows, [
      { id: 1, order_id: 1, distance_m: 500, points: 5, carbon_kg: 0.105 },
      { id: 2, order_id: 2, distance_m: 500, points: 5, carbon_kg: 0.105 },
    ]);
    await pool.query(
      "INSERT INTO ride_orders(id,user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,amount_cents,distance_m,status) VALUES(3,1,1,1,1,'2024-01-03 00:00:00','2024-01-03 00:05:00',100,500,'UNPAID')",
    );
    await pool.query(
      "INSERT INTO payments(order_id,idempotency_key,amount_cents) VALUES(3,'payment-modern-3',100)",
    );
    await pool.query("UPDATE ride_orders SET status='PAID' WHERE id=3");
    await pool.query(
      "INSERT INTO carbon_transactions(id,order_id,entry_type,idempotency_key,distance_m,points_change,carbon_kg_change,factor_kg_per_km,rule_version,reason,created_at) VALUES(3,3,'AWARD','modern-award-3',500,5,0.105,0.210,'carbon-v1','后续记录','2024-01-03 01:00:00.000')",
    );
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',13) WHERE name='pdf_expansion'",
    );
    await pool.query(
      "UPDATE carbon_transactions SET distance_m=501 WHERE id=1",
    );
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_CARBON_CONFLICT/,
    );
    const [[stillDifferent]] = await pool.query(
      "SELECT distance_m FROM carbon_transactions WHERE id=1",
    );
    assert.equal(stillDifferent.distance_m, 501);
    await pool.query(
      "UPDATE carbon_transactions SET distance_m=500 WHERE id=1",
    );
    await pool.query("DROP VIEW carbon_ledger");
    await pool.query("CREATE TABLE carbon_ledger LIKE carbon_ledger_legacy");
    await pool.query(
      "INSERT INTO carbon_ledger SELECT * FROM carbon_ledger_legacy",
    );
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_CARBON_LEGACY_COLLISION/,
    );
    const [[retained]] = await pool.query(
      "SELECT (SELECT COUNT(*) FROM carbon_ledger) source_rows,(SELECT COUNT(*) FROM carbon_ledger_legacy) backup_rows",
    );
    assert.deepEqual(retained, { source_rows: 2, backup_rows: 2 });
    await pool.query("DROP TABLE carbon_ledger");
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, [
      "pdf_expansion@17",
    ]);
    const [[restored]] = await pool.query(
      "SELECT table_type AS kind FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='carbon_ledger'",
    );
    assert.equal(restored.kind, "VIEW");
    assert.deepEqual(
      (
        await pool.query(
          "SELECT id,order_id,distance_m,points,carbon_kg FROM carbon_ledger ORDER BY id",
        )
      )[0],
      [
        ...compatibilityRows,
        { id: 3, order_id: 3, distance_m: 500, points: 5, carbon_kg: 0.105 },
      ],
    );
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});

test("migration preserves partial roads and rejects incomplete measured attributes", async () => {
  const database = `campus_bike_road_migration_${randomBytes(4).toString("hex")}`;
  const credentials = {
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  };
  const admin = createPool({ ...credentials, database: undefined });
  let pool,
    created = false;
  try {
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    pool = createPool({ ...credentials, database });
    await applySchema(pool);
    await pool.query(
      "INSERT INTO road_nodes(id,name,x,y) VALUES(1,'起点',0,0),(2,'终点',10,10)",
    );
    await pool.query(
      "INSERT INTO road_edges(id,from_node_id,to_node_id,distance_m,slope_percent,surface,shade_level,lighting_level,traffic_mix,intersection_risk,attribute_source) VALUES(1,1,2,15,7.25,'ROUGH',5,2,'BIKE_ONLY',4,'MEASURED')",
    );
    await pool.query(
      "ALTER TABLE road_edges DROP CHECK chk_road_attributes, DROP COLUMN lighting_level",
    );
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',0) WHERE name='pdf_expansion'",
    );
    const [[beforeRevision]] = await pool.query(
      "SELECT value FROM system_settings WHERE name='procedure_revision'",
    );
    const [[before]] = await pool.query(
      "SELECT slope_percent,surface,shade_level,traffic_mix,intersection_risk,attribute_source FROM road_edges WHERE id=1",
    );
    await assert.rejects(
      applyFeatureMigrations(pool),
      /MIGRATION_INCOMPLETE_MEASURED_ROADS/,
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT slope_percent,surface,shade_level,traffic_mix,intersection_risk,attribute_source FROM road_edges WHERE id=1",
        )
      )[0][0],
      before,
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT value FROM system_settings WHERE name='procedure_revision'",
        )
      )[0][0],
      beforeRevision,
    );
    const [[missing]] = await pool.query(
      "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='road_edges' AND column_name='lighting_level'",
    );
    assert.equal(missing.n, 0);
    await pool.query(
      "UPDATE road_edges SET attribute_source='SIMULATED_COURSE_DATA' WHERE id=1",
    );
    await applyFeatureMigrations(pool);
    const [[partial]] = await pool.query(
      "SELECT slope_percent,surface,shade_level,lighting_level,traffic_mix,intersection_risk,attribute_source FROM road_edges WHERE id=1",
    );
    assert.deepEqual(partial, {
      ...before,
      attribute_source: "SIMULATED_COURSE_DATA",
      lighting_level: 3,
    });
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
    await pool.query(
      "ALTER TABLE road_edges DROP CHECK chk_road_attributes, DROP COLUMN slope_percent, DROP COLUMN surface, DROP COLUMN shade_level, DROP COLUMN lighting_level, DROP COLUMN traffic_mix, DROP COLUMN intersection_risk, DROP COLUMN attribute_source",
    );
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version',0) WHERE name='pdf_expansion'",
    );
    await applyFeatureMigrations(pool);
    const [[fresh]] = await pool.query(
      "SELECT slope_percent,surface,shade_level,lighting_level,traffic_mix,intersection_risk,attribute_source FROM road_edges WHERE id=1",
    );
    assert.deepEqual(fresh, {
      slope_percent: -1.5,
      surface: "SMOOTH",
      shade_level: 3,
      lighting_level: 4,
      traffic_mix: "MIXED",
      intersection_risk: 1,
      attribute_source: "SIMULATED_COURSE_DATA",
    });
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});

test("schema initialization rejects unknown or malformed migration versions before changing existing objects", async () => {
  const database = `campus_bike_version_test_${randomBytes(4).toString("hex")}`;
  const credentials = {
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  };
  const admin = createPool({ ...credentials, database: undefined });
  let pool,
    created = false;
  try {
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    pool = createPool({ ...credentials, database });
    await applySchema(pool);
    await pool.query("DROP PROCEDURE sp_dashboard");
    await pool.query(
      "CREATE PROCEDURE sp_dashboard(IN p_user BIGINT UNSIGNED, IN p_role VARCHAR(20)) SELECT '原有过程' AS marker",
    );
    await pool.query(
      "INSERT INTO users(id,name,email,phone,password_hash,role) VALUES(1,'测试用户','version@test.local','13700000001','hash','STUDENT')",
    );
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('version','17') WHERE name='pdf_expansion'",
    );
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
    const [[revisionBefore]] = await pool.query(
      "SELECT value FROM system_settings WHERE name='procedure_revision'",
    );
    const versions = [
      ["JSON_OBJECT('version',18)", /UNSUPPORTED_SCHEMA_VERSION/],
      ["JSON_OBJECT('version',999999)", /UNSUPPORTED_SCHEMA_VERSION/],
      [
        "CAST('{\"version\":18446744073709551615}' AS JSON)",
        /UNSUPPORTED_SCHEMA_VERSION/,
      ],
      [
        "JSON_OBJECT('version','999999999999999999999')",
        /UNSUPPORTED_SCHEMA_VERSION/,
      ],
      ["JSON_OBJECT('version',NULL)", /INVALID_SCHEMA_VERSION/],
      ["JSON_OBJECT()", /INVALID_SCHEMA_VERSION/],
      ["JSON_OBJECT('version','invalid')", /INVALID_SCHEMA_VERSION/],
      [
        "JSON_OBJECT('version',CONCAT('11',CHAR(10)))",
        /INVALID_SCHEMA_VERSION/,
      ],
      ["JSON_OBJECT('version','01')", /INVALID_SCHEMA_VERSION/],
      ["JSON_OBJECT('version','+11')", /INVALID_SCHEMA_VERSION/],
      ["JSON_OBJECT('version',-1)", /INVALID_SCHEMA_VERSION/],
      ["JSON_OBJECT('version',1.5)", /INVALID_SCHEMA_VERSION/],
    ];
    for (const [expression, expected] of versions) {
      await pool.query(
        `UPDATE system_settings SET value=${expression} WHERE name='pdf_expansion'`,
      );
      await assert.rejects(applyFeatureMigrations(pool), expected);
      await assert.rejects(applySchema(pool), expected);
      const [result] = await pool.query("CALL sp_dashboard(?,?)", [
        1,
        "STUDENT",
      ]);
      assert.equal(result[0][0].marker, "原有过程");
      const [[user]] = await pool.query("SELECT name FROM users WHERE id=1");
      assert.equal(user.name, "测试用户");
      const [[revisionAfter]] = await pool.query(
        "SELECT value FROM system_settings WHERE name='procedure_revision'",
      );
      assert.deepEqual(revisionAfter, revisionBefore);
      const [[{ temporary }]] = await pool.query(
        "SELECT COUNT(*) AS temporary FROM information_schema.routines WHERE routine_schema=DATABASE() AND LEFT(routine_name,19)='qingxing_migration_'",
      );
      assert.equal(temporary, 0);
    }
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
