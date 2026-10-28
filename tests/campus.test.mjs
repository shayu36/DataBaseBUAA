import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import campus from "../database/campus-map.json" with { type: "json" };
import previousCampus from "../database/campus-map-v2.json" with { type: "json" };
import firstCampus from "../database/campus-map-v1.json" with { type: "json" };
import {
  createPool,
  ledgerTransaction,
  withNamedLock,
  withSchemaLock,
} from "../backend/db.mjs";
import { applySchema } from "../scripts/sql.mjs";
import { findRoute } from "../backend/analytics.mjs";
import { upgradeCampusMap } from "../backend/campus.mjs";

const pool = createPool({
  database: "campus_bike_test",
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
const legacyZones = [
  [1, "东门驿站", "校园东门 · 主入口", 160, 440],
  [2, "图书馆", "图书馆南侧 · 知行广场", 450, 180],
  [3, "教学楼", "第一教学楼 · 东侧", 760, 210],
  [4, "学生公寓", "学生生活区 · 榕树路", 210, 750],
  [5, "中心食堂", "中心食堂 · 北广场", 530, 550],
  [6, "运动场", "体育中心 · 西门", 850, 700],
];
const legacyEdges = [
  [1, 2, 390, 4, 3],
  [1, 4, 320, 1, 2],
  [1, 7, 265, 1, 1],
  [2, 3, 320, 3, 2],
  [2, 7, 225, 1, 1],
  [3, 8, 255, 1, 1],
  [4, 5, 385, 2, 1],
  [4, 7, 410, 1, 2],
  [5, 6, 365, 3, 2],
  [5, 7, 190, 1, 1],
  [5, 8, 235, 1, 1],
  [6, 8, 275, 1, 1],
  [7, 8, 320, 1, 1],
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
  for (const [id, name, location, x, y] of legacyZones) {
    await pool.query(
      "INSERT INTO parking_zones(id,name,location,x,y,radius,capacity) VALUES(?,?,?,?,?,45,28)",
      [id, name, location, x, y],
    );
    await pool.query(
      "INSERT INTO road_nodes(id,name,x,y,zone_id) VALUES(?,?,?,?,?)",
      [id, name, x, y, id],
    );
  }
  await pool.query(
    "INSERT INTO road_nodes(id,name,x,y) VALUES(7,'银杏路口',420,400),(8,'湖畔绿道',730,460)",
  );
  for (const [a, b, distance, safety, comfort] of legacyEdges)
    await pool.query(
      "INSERT INTO road_edges(from_node_id,to_node_id,distance_m,safety_cost,comfort_cost) VALUES(?,?,?,?,?)",
      [a, b, distance, safety, comfort],
    );
  await pool.query(
    "INSERT INTO system_settings(name,value) VALUES('seed_version',JSON_OBJECT('version',1))",
  );
  await pool.query(
    "INSERT INTO bikes(id,code,deployed_at,current_zone_id) VALUES(1,'QX-MAP',UTC_DATE(),1)",
  );
});
after(() => pool.end());

test("official-plan graph connects all stations with consistent route lengths", () => {
  for (const edge of campus.edges) {
    const a = campus.nodes.find((n) => n.id === edge.from_node_id),
      b = campus.nodes.find((n) => n.id === edge.to_node_id);
    assert.ok(a && b);
    assert.equal(edge.distance_m, Math.round(Math.hypot(a.x - b.x, a.y - b.y)));
  }
  for (const a of campus.zones)
    for (const b of campus.zones)
      for (const mode of ["shortest", "safe", "comfortable"]) {
        const route = findRoute(campus.nodes, campus.edges, a.id, b.id, mode);
        assert.ok(a.id === b.id || route.distance_m > 0);
      }
});
test("campus graph covers family roads and declares both no-ride areas", () => {
  assert.equal(campus.version, "beihang-xueyuan-3");
  assert.equal(
    campus.planSource,
    "https://www.buaa.edu.cn/images/xylxq20261013.jpg",
  );
  assert.deepEqual(
    campus.restricted_areas.map((area) => area.name),
    ["主楼三号教学楼禁行区", "图书馆禁行区"],
  );
  for (const area of campus.restricted_areas) {
    assert.equal(area.rule, "NO_RIDE");
    assert.ok(area.points.length >= 4);
  }
  const familyNodes = campus.nodes.filter((node) => node.area === "FAMILY");
  assert.ok(familyNodes.length >= 5);
  for (const node of familyNodes)
    assert.ok(
      campus.edges.some(
        (edge) => edge.from_node_id === node.id || edge.to_node_id === node.id,
      ),
    );
  const forbiddenEdges = campus.edges.filter(
    (edge) => edge.status === "NO_RIDE",
  );
  assert.ok(forbiddenEdges.length >= 2);
  const route = findRoute(campus.nodes, campus.edges, 1, 4, "shortest");
  const pairs = new Set(
    route.segments.map((segment) =>
      [segment.from_node_id, segment.to_node_id]
        .sort((a, b) => a - b)
        .join(":"),
    ),
  );
  for (const edge of forbiddenEdges)
    assert.equal(
      pairs.has(
        [edge.from_node_id, edge.to_node_id].sort((a, b) => a - b).join(":"),
      ),
      false,
    );
});
async function loadVersionedCampus(map) {
  await pool.query("DELETE FROM road_edges");
  await pool.query("DELETE FROM road_nodes");
  for (const z of map.zones)
    await pool.query(
      "UPDATE parking_zones SET name=?,location=?,x=?,y=?,radius=35 WHERE id=?",
      [z.name, z.location, z.x, z.y, z.id],
    );
  for (const n of map.nodes)
    await pool.query(
      "INSERT INTO road_nodes(id,name,x,y,zone_id) VALUES(?,?,?,?,?)",
      [n.id, n.name, n.x, n.y, n.zone_id ?? null],
    );
  for (const e of map.edges) {
    const i = e.id;
    await pool.query(
      "INSERT INTO road_edges(from_node_id,to_node_id,distance_m,safety_cost,comfort_cost,direction,status,slope_percent,surface,shade_level,lighting_level,traffic_mix,intersection_risk) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        e.from_node_id,
        e.to_node_id,
        e.distance_m,
        e.safety_cost,
        e.comfort_cost,
        e.direction ?? "BOTH",
        e.status ?? "OPEN",
        ((i % 5) - 2) * 1.5,
        i % 5 === 0 ? "ROUGH" : i % 2 === 0 ? "AVERAGE" : "SMOOTH",
        Math.min(5, 2 + (i % 4)),
        5 - (i % 3),
        i % 7 === 0 ? "MOTOR_HEAVY" : i % 3 === 0 ? "BIKE_ONLY" : "MIXED",
        i % 4,
      ],
    );
  }
  await pool.query(
    "INSERT INTO system_settings(name,value) VALUES('campus_map',JSON_OBJECT('version',?))",
    [map.version],
  );
}
for (const prior of [firstCampus, previousCampus]) {
  test(`campus map upgrades the unmodified ${prior.version} graph without changing rides`, async () => {
    await loadVersionedCampus(prior);
    await pool.query(
      "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,amount_cents,distance_m,status) VALUES(1,1,1,2,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR),UTC_TIMESTAMP(),100,390,'UNPAID')",
    );
    const [before] = await pool.query("SELECT * FROM ride_orders");
    assert.equal(await ledgerTransaction(pool, upgradeCampusMap), true);
    assert.equal(await ledgerTransaction(pool, upgradeCampusMap), false);
    assert.deepEqual(
      (await pool.query("SELECT * FROM ride_orders"))[0],
      before,
    );
    assert.equal(
      (await pool.query("SELECT COUNT(*) n FROM road_edges"))[0][0].n,
      campus.edges.length,
    );
  });
  test(`campus map retains customized ${prior.version} data and road audit history`, async () => {
    await loadVersionedCampus(prior);
    await ledgerTransaction(pool, async (connection) => {
      for (const statement of [
        "UPDATE parking_zones SET location='自定义地点' WHERE id=1",
        "UPDATE parking_zones SET radius=36 WHERE id=1",
        "UPDATE road_edges SET distance_m=distance_m+1 ORDER BY id LIMIT 1",
        "UPDATE road_edges SET safety_cost=safety_cost+1 ORDER BY id LIMIT 1",
        "UPDATE road_edges SET slope_percent=slope_percent+1 ORDER BY id LIMIT 1",
        "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) SELECT 1,'ROAD_UPDATE','road_edges',id FROM road_edges LIMIT 1",
      ]) {
        await connection.query("SAVEPOINT map_change");
        await connection.query(statement);
        const [before] = await connection.query(
          "SELECT * FROM road_edges ORDER BY id",
        );
        await assert.rejects(
          upgradeCampusMap(connection),
          /customized map/,
          statement,
        );
        assert.deepEqual(
          (await connection.query("SELECT * FROM road_edges ORDER BY id"))[0],
          before,
        );
        await connection.query("ROLLBACK TO SAVEPOINT map_change");
      }
    });
  });
}
test("campus upgrade completes while the migration holds both named locks", async () => {
  await loadVersionedCampus(firstCampus);
  const migrated = await withSchemaLock(pool, (connection) =>
    withNamedLock(connection, () =>
      ledgerTransaction(connection, upgradeCampusMap),
    ),
  );
  assert.equal(migrated, true);
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

test("campus migration accepts the original graph after legacy attribute generation", async () => {
  await pool.query(`UPDATE road_edges SET slope_percent=(CAST(MOD(id,5) AS SIGNED)-2)*1.5,
    surface=CASE WHEN MOD(id,5)=0 THEN 'ROUGH' WHEN MOD(id,2)=0 THEN 'AVERAGE' ELSE 'SMOOTH' END,
    shade_level=LEAST(5,2+MOD(id,4)),lighting_level=5-MOD(id,3),
    traffic_mix=CASE WHEN MOD(id,7)=0 THEN 'MOTOR_HEAVY' WHEN MOD(id,3)=0 THEN 'BIKE_ONLY' ELSE 'MIXED' END,
    intersection_risk=MOD(id,4)`);
  await pool.query("UPDATE parking_zones SET capacity=37 WHERE id=1");
  assert.equal(await ledgerTransaction(pool, upgradeCampusMap), true);
  const [[zone]] = await pool.query(
    "SELECT capacity FROM parking_zones WHERE id=1",
  );
  assert.equal(zone.capacity, 37);
});

test("campus migration preserves customized station and road attributes", async () => {
  await ledgerTransaction(pool, async (connection) => {
    for (const statement of [
      "UPDATE parking_zones SET location='自定义地点' WHERE id=1",
      "UPDATE parking_zones SET radius=46 WHERE id=1",
      "UPDATE road_edges SET id=100 WHERE id=1",
      "UPDATE road_edges SET distance_m=391 WHERE id=1",
      "UPDATE road_edges SET safety_cost=5 WHERE id=1",
      "UPDATE road_edges SET comfort_cost=4 WHERE id=1",
      "UPDATE road_edges SET direction='FORWARD' WHERE id=1",
      "UPDATE road_edges SET status='CLOSED' WHERE id=1",
      "UPDATE road_edges SET slope_percent=1.25 WHERE id=1",
      "UPDATE road_edges SET surface='ROUGH' WHERE id=1",
      "UPDATE road_edges SET shade_level=5 WHERE id=1",
      "UPDATE road_edges SET lighting_level=1 WHERE id=1",
      "UPDATE road_edges SET traffic_mix='MOTOR_HEAVY' WHERE id=1",
      "UPDATE road_edges SET intersection_risk=5 WHERE id=1",
      "UPDATE road_edges SET attribute_source='MEASURED' WHERE id=1",
    ]) {
      await connection.query("SAVEPOINT custom_map");
      await connection.query(statement);
      const [zones] = await connection.query(
        "SELECT * FROM parking_zones ORDER BY id",
      );
      const [edges] = await connection.query(
        "SELECT * FROM road_edges ORDER BY id",
      );
      await assert.rejects(
        upgradeCampusMap(connection),
        /customized map/,
        statement,
      );
      assert.deepEqual(
        (await connection.query("SELECT * FROM parking_zones ORDER BY id"))[0],
        zones,
      );
      assert.deepEqual(
        (await connection.query("SELECT * FROM road_edges ORDER BY id"))[0],
        edges,
      );
      await connection.query("ROLLBACK TO SAVEPOINT custom_map");
    }
  });
});

test("campus migration refuses to orphan road audit history", async () => {
  await pool.query(
    "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES(1,'ROAD_UPDATE','road_edges',1)",
  );
  const [edges] = await pool.query("SELECT * FROM road_edges ORDER BY id");
  await assert.rejects(
    ledgerTransaction(pool, upgradeCampusMap),
    /customized map/,
  );
  assert.deepEqual(
    (await pool.query("SELECT * FROM road_edges ORDER BY id"))[0],
    edges,
  );
});

test("campus migration rejects an unknown or malformed version marker", async () => {
  await pool.query(
    "INSERT INTO system_settings(name,value) VALUES('campus_map',JSON_OBJECT('version','unknown'))",
  );
  await assert.rejects(
    ledgerTransaction(pool, upgradeCampusMap),
    /Unknown campus map version/,
  );
  await pool.query(
    "UPDATE system_settings SET value=JSON_OBJECT() WHERE name='campus_map'",
  );
  await assert.rejects(
    ledgerTransaction(pool, upgradeCampusMap),
    /Unknown campus map version/,
  );
});
