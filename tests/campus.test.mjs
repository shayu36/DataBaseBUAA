import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import campus from "../database/campus-map.json" with { type: "json" };
import { createPool, ledgerTransaction } from "../server/db.mjs";
import { applySchema } from "../scripts/sql.mjs";
import { findRoute } from "../server/analytics.mjs";
import { upgradeCampusMap } from "../server/campus.mjs";

const pool = createPool({
  database: "campus_bike_test",
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
const legacyZones = [
  [1, "东门驿站", 160, 440],
  [2, "图书馆", 450, 180],
  [3, "教学楼", 760, 210],
  [4, "学生公寓", 210, 750],
  [5, "中心食堂", 530, 550],
  [6, "运动场", 850, 700],
];
const legacyEdges = [
  [1, 2],
  [1, 4],
  [1, 7],
  [2, 3],
  [2, 7],
  [3, 8],
  [4, 5],
  [4, 7],
  [5, 6],
  [5, 7],
  [5, 8],
  [6, 8],
  [7, 8],
];
before(async () => {
  assert.equal(
    (await pool.query("SELECT DATABASE() db"))[0][0].db,
    "campus_bike_test",
  );
  await applySchema(pool);
});
beforeEach(async () => {
  const c = await pool.getConnection();
  try {
    await c.query("SET FOREIGN_KEY_CHECKS=0");
    const [tables] = await c.query(
      "SELECT table_name name FROM information_schema.tables WHERE table_schema='campus_bike_test' AND table_type='BASE TABLE'",
    );
    for (const { name } of tables) await c.query(`TRUNCATE TABLE \`${name}\``);
  } finally {
    await c.query("SET FOREIGN_KEY_CHECKS=1");
    c.release();
  }
  await pool.query(
    "INSERT INTO users(id,name,email,phone,password_hash) VALUES(1,'测试','map@test.local','13800000000','test')",
  );
  for (const [id, name, x, y] of legacyZones) {
    await pool.query(
      "INSERT INTO parking_zones(id,name,location,x,y,radius,capacity) VALUES(?,?,'原始位置',?,?,45,28)",
      [id, name, x, y],
    );
    await pool.query(
      "INSERT INTO road_nodes(id,name,x,y,zone_id) VALUES(?,?,?,?,?)",
      [id, name, x, y, id],
    );
  }
  await pool.query(
    "INSERT INTO road_nodes(id,name,x,y) VALUES(7,'银杏路口',420,400),(8,'湖畔绿道',730,460)",
  );
  for (const [a, b] of legacyEdges)
    await pool.query(
      "INSERT INTO road_edges(from_node_id,to_node_id,distance_m) VALUES(?,?,300)",
      [a, b],
    );
  await pool.query(
    "INSERT INTO system_settings(name,value) VALUES('seed_version',JSON_OBJECT('version',1))",
  );
  await pool.query(
    "INSERT INTO bikes(id,code,deployed_at,current_zone_id) VALUES(1,'QX-MAP',UTC_DATE(),1)",
  );
});
after(() => pool.end());

test("campus graph connects all stations with rectilinear roads and consistent lengths", () => {
  for (const edge of campus.edges) {
    const a = campus.nodes.find((n) => n.id === edge.from_node_id),
      b = campus.nodes.find((n) => n.id === edge.to_node_id);
    assert.ok(a.x === b.x || a.y === b.y);
    assert.equal(edge.distance_m, Math.round(Math.hypot(a.x - b.x, a.y - b.y)));
  }
  for (const a of campus.zones)
    for (const b of campus.zones)
      for (const mode of ["shortest", "safe", "comfortable"]) {
        const route = findRoute(campus.nodes, campus.edges, a.id, b.id, mode);
        assert.ok(a.id === b.id || route.distance_m > 0);
      }
});
test("campus migration preserves historical rides and bikes, aligns station nodes, and is idempotent", async () => {
  await pool.query(
    "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,amount_cents,distance_m,status) VALUES(1,1,1,2,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR),UTC_TIMESTAMP(),100,390,'UNPAID')",
  );
  const [before] = await pool.query("SELECT * FROM ride_orders");
  assert.equal(await ledgerTransaction(pool, upgradeCampusMap), true);
  assert.equal(await ledgerTransaction(pool, upgradeCampusMap), false);
  assert.deepEqual((await pool.query("SELECT * FROM ride_orders"))[0], before);
  assert.equal(
    (await pool.query("SELECT current_zone_id FROM bikes WHERE id=1"))[0][0]
      .current_zone_id,
    1,
  );
  const [zones] = await pool.query(
    "SELECT z.id,z.x,z.y,n.x nx,n.y ny FROM parking_zones z JOIN road_nodes n ON n.zone_id=z.id",
  );
  for (const z of zones) {
    const expected = campus.zones.find((s) => s.id === z.id);
    assert.equal(z.x, expected.x);
    assert.equal(z.y, expected.y);
    assert.equal(z.x, z.nx);
    assert.equal(z.y, z.ny);
  }
  assert.equal(
    (await pool.query("SELECT COUNT(*) n FROM road_edges"))[0][0].n,
    campus.edges.length,
  );
});
test("campus migration refuses active rides before changing coordinates", async () => {
  await pool.query(
    "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,status) VALUES(1,1,1,'RUNNING')",
  );
  await assert.rejects(
    ledgerTransaction(pool, upgradeCampusMap),
    /active rides or dispatches/,
  );
  assert.equal(
    (await pool.query("SELECT x FROM parking_zones WHERE id=1"))[0][0].x,
    160,
  );
});
test("campus migration refuses a customized map rather than overwriting it", async () => {
  await pool.query(
    "INSERT INTO road_nodes(id,name,x,y) VALUES(9,'用户新增路口',150,100)",
  );
  await assert.rejects(
    ledgerTransaction(pool, upgradeCampusMap),
    /customized map/,
  );
  assert.equal(
    (await pool.query("SELECT x FROM parking_zones WHERE id=1"))[0][0].x,
    160,
  );
});
