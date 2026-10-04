import bcrypt from "bcryptjs";
import { createPool, ledgerTransaction } from "../server/db.mjs";
import { routeForZones, carbonKilograms } from "../server/business.mjs";
const pool = createPool();
try {
  if (process.env.DB_NAME !== "campus_bike")
    throw new Error("Seeding is restricted to campus_bike.");
  await ledgerTransaction(pool, async (c) => {
    const [[seed]] = await c.query(
      "SELECT name FROM system_settings WHERE name='seed_version'",
    );
    if (seed) {
      console.log("Campus demo already seeded; existing data preserved.");
      return;
    }
    const [[{ n }]] = await c.query("SELECT COUNT(*) n FROM users");
    if (n)
      throw new Error("Nonempty unmarked database: refusing automatic seed.");
    const hash = await bcrypt.hash("Qingxing2026!", 10);
    for (const [id, name, email, role] of [
      [1, "贾鑫洋", "jia", "ADMIN"],
      [2, "欧阳晨", "ouyang", "STUDENT"],
      [3, "郑一凡", "zheng", "OPERATOR"],
      [4, "王奕", "wang", "STUDENT"],
    ]) {
      await c.query(
        "INSERT INTO users(id,name,email,phone,password_hash,role) VALUES(?,?,?,?,?,?)",
        [id, name, email + "@qingxing.local", "1380000000" + id, hash, role],
      );
    }
    await c.query(
      "INSERT INTO staff(id,user_id,name,phone,job) VALUES(1,3,'郑一凡','13800000003','BOTH')",
    );
    const zones = [
      [1, "东门驿站", "校园东门 · 主入口", 160, 440, 24, 16],
      [2, "图书馆", "图书馆南侧 · 知行广场", 450, 180, 24, 2],
      [3, "教学楼", "第一教学楼 · 东侧", 760, 210, 20, 10],
      [4, "学生公寓", "学生生活区 · 榕树路", 210, 750, 28, 25],
      [5, "中心食堂", "中心食堂 · 北广场", 530, 550, 18, 9],
      [6, "运动场", "体育中心 · 西门", 850, 700, 16, 4],
    ];
    let bikeId = 1;
    for (const [id, name, location, x, y, capacity, count] of zones) {
      await c.query(
        "INSERT INTO parking_zones(id,name,location,x,y,radius,capacity) VALUES(?,?,?,?,?,45,?)",
        [id, name, location, x, y, capacity],
      );
      await c.query(
        "INSERT INTO road_nodes(id,name,x,y,zone_id) VALUES(?,?,?,?,?)",
        [id, name, x, y, id],
      );
      for (let i = 0; i < count; i++)
        await c.query(
          "INSERT INTO bikes(id,code,deployed_at,current_zone_id,last_service_at) VALUES(?,?,DATE_SUB(UTC_DATE(),INTERVAL 120 DAY),?,DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? DAY))",
          [
            bikeId,
            "QX-" + String(bikeId++).padStart(3, "0"),
            id,
            (i * 7) % 100,
          ],
        );
    }
    await c.query(
      "INSERT INTO road_nodes(id,name,x,y) VALUES(7,'银杏路口',420,400),(8,'湖畔绿道',730,460)",
    );
    for (const [a, b, d, s, f] of [
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
    ]) {
      await c.query(
        "INSERT INTO road_edges(from_node_id,to_node_id,distance_m,safety_cost,comfort_cost) VALUES(?,?,?,?,?)",
        [a, b, d, s, f],
      );
    }
    const now = new Date(),
      base = new Date(now);
    base.setUTCHours(0, 0, 0, 0);
    for (let day = 0; day < 14; day++)
      for (let u = 1; u <= 4; u++)
        for (let trip = 0; trip < 3; trip++) {
          const from = ((day + u + trip) % 6) + 1,
            to = ((from + trip) % 6) + 1;
          const started = new Date(
            base.getTime() -
              day * 86400000 +
              (trip * 5 + 1) * 3600000 +
              u * 600000,
          );
          if (started.getTime() + 1200000 > now.getTime()) continue;
          const ended = new Date(started.getTime() + 1200000),
            route = await routeForZones(c, from, to, "shortest");
          const [r] = await c.query(
            "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,amount_cents,distance_m,status) VALUES(?,?,?,?,?,?,100,?,'UNPAID')",
            [u, u, from, to, started, ended, Math.round(route.distance_m)],
          );
          await c.query(
            "INSERT INTO payments(order_id,idempotency_key,amount_cents,paid_at) VALUES(?,?,100,?)",
            [r.insertId, "seed-" + r.insertId, ended],
          );
          await c.query("UPDATE ride_orders SET status='PAID' WHERE id=?", [
            r.insertId,
          ]);
          await c.query(
            "INSERT INTO carbon_ledger(order_id,distance_m,points,carbon_kg,created_at) VALUES(?,?,?,?,?)",
            [
              r.insertId,
              route.distance_m,
              Math.floor(route.distance_m / 100),
              carbonKilograms(route.distance_m),
              ended,
            ],
          );
        }
    for (const ago of [3, 12, 22]) {
      await c.query(
        "INSERT INTO maintenance_tickets(bike_id,reporter_id,staff_id,fault_type,description,status,result,created_at,completed_at) VALUES(1,2,1,'BRAKE','演示历史：制动性能下降','COMPLETED','检查并更换制动组件',DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? DAY),DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? DAY))",
        [ago, ago - 1],
      );
    }
    await c.query(
      "UPDATE bikes SET last_service_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 2 DAY) WHERE id=1",
    );
    await c.query(
      "INSERT INTO maintenance_tickets(bike_id,reporter_id,fault_type,description) VALUES(63,4,'LOCK','演示报修：车锁无法正常打开')",
    );
    await c.query(
      "INSERT INTO maintenance_tickets(bike_id,reporter_id,staff_id,fault_type,description,status) VALUES(15,2,1,'TIRE','演示报修：后轮缓慢漏气','ASSIGNED')",
    );
    await c.query("UPDATE bikes SET status='MAINTENANCE' WHERE id IN(15,63)");
    const snapshots = [];
    for (let day = 0; day < 7; day++)
      for (let i = 0; i < 49; i++) {
        const captured = new Date(base.getTime() - day * 86400000 + i * 300000);
        if (captured > now) continue;
        for (const [id, , , , , capacity] of zones) {
          const occupied =
            id === 4
              ? i % 12 < 5
                ? capacity
                : Math.floor(capacity * 0.8)
              : Math.max(
                  0,
                  Math.min(
                    capacity,
                    Math.round(capacity * (0.48 + 0.4 * Math.sin(i / 5 + id))),
                  ),
                );
          snapshots.push([
            id,
            Math.max(0, occupied - (id === 1 || id === 6 ? 1 : 0)),
            occupied,
            capacity,
            captured,
            "DEMO",
          ]);
        }
      }
    await c.query(
      "INSERT INTO zone_snapshots(zone_id,available,occupied,capacity,captured_at,source) VALUES ?",
      [snapshots],
    );
    await c.query(
      "INSERT INTO system_settings(name,value) VALUES('seed_version',JSON_OBJECT('version',1,'history','synthetic'))",
    );
    await c.query(
      "INSERT INTO system_settings(name,value) VALUES('pricing',JSON_OBJECT('per_30_minutes_cents',100)),('carbon',JSON_OBJECT('kg_per_km',0.21,'points_per_km',10,'source','ROUTE_ESTIMATE'))",
    );
    console.log(
      "Seeded: 6 parking zones, 66 bikes, 4 accounts, connected road network and labeled demo history.",
    );
  });
} finally {
  await pool.end();
}
