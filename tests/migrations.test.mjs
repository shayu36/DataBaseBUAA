import test from "node:test";
import assert from "node:assert/strict";
import { createPool } from "../server/db.mjs";
import { applyFeatureMigrations } from "../server/feature-migrations.mjs";

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
      "INSERT INTO users VALUES(1,'学生','s@test','13800000000','hash','STUDENT','ACTIVE',UTC_TIMESTAMP(3))",
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

    const first = await applyFeatureMigrations(pool);
    const second = await applyFeatureMigrations(pool);
    assert.ok(first.applied.length > 0);
    assert.deepEqual(second.applied, []);
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
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.end();
  }
});
