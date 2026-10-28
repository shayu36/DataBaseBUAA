import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPool } from "../backend/db.mjs";
import { applyFeatureMigrations } from "../backend/feature-migrations.mjs";
import { applySchema } from "../scripts/sql.mjs";

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
      attribute_source: "SIMULATED_COURSE_DATA",
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
      "CREATE VIEW carbon_ledger AS SELECT id,order_id,distance_m,points_change points,carbon_kg_change carbon_kg,factor_kg_per_km,created_at FROM carbon_transactions WHERE entry_type='AWARD'",
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
      "UPDATE system_settings SET value=JSON_OBJECT('version','11') WHERE name='pdf_expansion'",
    );
    assert.deepEqual((await applyFeatureMigrations(pool)).applied, []);
    const versions = [
      ["JSON_OBJECT('version',12)", /UNSUPPORTED_SCHEMA_VERSION/],
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
