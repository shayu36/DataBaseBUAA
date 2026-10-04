import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { createPool } from "../server/db.mjs";
import { applySchema } from "../scripts/sql.mjs";
import {
  saveZone,
  saveBike,
  saveStaff,
  setUserStatus,
} from "../server/admin.mjs";
import {
  startRide,
  returnRide,
  createDispatch,
  reportFault,
  maintenanceAction,
} from "../server/business.mjs";
const pool = createPool({
  database: "campus_bike_test",
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
const admin = { id: 1, role: "ADMIN" },
  student = { id: 2, role: "STUDENT" };
before(async () => {
  const [[{ name }]] = await pool.query("SELECT DATABASE() name");
  assert.equal(name, "campus_bike_test");
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
    await c.query("SET FOREIGN_KEY_CHECKS=1");
  } finally {
    c.release();
  }
  const hash = await bcrypt.hash("Qingxing2026!", 4);
  for (const [id, role] of [
    [1, "ADMIN"],
    [2, "STUDENT"],
    [3, "OPERATOR"],
  ])
    await pool.query(
      "INSERT INTO users(id,name,email,phone,password_hash,role) VALUES(?,?,?,?,?,?)",
      [id, "测试" + id, `u${id}@test.local`, `1380000000${id}`, hash, role],
    );
  await pool.query(
    "INSERT INTO parking_zones(id,name,location,x,y,radius,capacity) VALUES(1,'A','北',100,100,40,5),(2,'B','南',500,100,40,2)",
  );
  await pool.query(
    "INSERT INTO bikes(id,code,deployed_at,current_zone_id) VALUES(1,'QX1','2026-01-01',1),(2,'QX2','2026-01-01',1)",
  );
  await pool.query(
    "INSERT INTO staff(id,user_id,name,phone,job) VALUES(1,3,'测试3','13800000003','BOTH')",
  );
  await pool.query(
    "INSERT INTO road_nodes(id,name,x,y,zone_id) SELECT id,name,x,y,id FROM parking_zones",
  );
  await pool.query(
    "INSERT INTO road_edges(from_node_id,to_node_id,distance_m) VALUES(1,2,400)",
  );
});
after(() => pool.end());
const zone = (extra = {}) => ({
  id: 1,
  name: "A",
  location: "北",
  x: 100,
  y: 100,
  radius: 40,
  capacity: 5,
  status: "ACTIVE",
  ...extra,
});
const staff = (extra = {}) => ({
  name: "新员工",
  phone: "13900000001",
  email: "new@test.local",
  password: "Qingxing2026!",
  job: "BOTH",
  status: "ACTIVE",
  ...extra,
});
test("admin authorization on all operations", async () => {
  for (const fn of [
    () => saveZone(pool, student, zone()),
    () => saveBike(pool, student, { code: "N", zone_id: 1 }),
    () => saveStaff(pool, student, staff()),
    () => setUserStatus(pool, student, 1, { status: "SUSPENDED" }),
  ])
    await assert.rejects(fn(), { status: 403 });
});
test("zone capacity, closing and geometry protect occupied bikes and reservations", async () => {
  await assert.rejects(saveZone(pool, admin, zone({ capacity: 1 })), {
    code: "ZONE_FULL",
  });
  await assert.rejects(saveZone(pool, admin, zone({ status: "CLOSED" })));
  await assert.rejects(saveZone(pool, admin, zone({ x: 110 })));
  await createDispatch(pool, admin, {
    source_zone_id: 1,
    target_zone_id: 2,
    bike_ids: [1, 2],
    staff_id: 1,
  });
  await assert.rejects(
    saveZone(pool, admin, zone({ id: 2, name: "B", x: 500, capacity: 1 })),
    { code: "ZONE_FULL" },
  );
});
test("new zone connects to nearest road node and empty zone edits sync graph", async () => {
  const { id } = await saveZone(
    pool,
    admin,
    zone({ id: undefined, name: "C", x: 600, y: 100 }),
  );
  const [[node]] = await pool.query(
    "SELECT * FROM road_nodes WHERE zone_id=?",
    [id],
  );
  const [[edge]] = await pool.query(
    "SELECT * FROM road_edges WHERE to_node_id=?",
    [node.id],
  );
  assert.equal(edge.from_node_id, 2);
  assert.equal(edge.distance_m, 100);
  await saveZone(pool, admin, zone({ id, name: "C", x: 700, y: 100 }));
  const [[n]] = await pool.query("SELECT x FROM road_nodes WHERE zone_id=?", [
    id,
  ]);
  assert.equal(Number(n.x), 700);
  const [[e]] = await pool.query(
    "SELECT distance_m FROM road_edges WHERE to_node_id=?",
    [node.id],
  );
  assert.equal(e.distance_m, 200);
});
test("radius-only updates preserve road lengths while coordinate moves update them", async () => {
  await pool.query(
    "UPDATE road_edges SET distance_m=650 WHERE from_node_id=1 AND to_node_id=2",
  );
  await saveZone(
    pool,
    admin,
    zone({ id: 2, name: "B", x: 500, capacity: 2, radius: 45 }),
  );
  const [[unchanged]] = await pool.query(
    "SELECT distance_m FROM road_edges WHERE from_node_id=1 AND to_node_id=2",
  );
  assert.equal(unchanged.distance_m, 650);
  await saveZone(
    pool,
    admin,
    zone({ id: 2, name: "B", x: 600, capacity: 2, radius: 45 }),
  );
  const [[moved]] = await pool.query(
    "SELECT distance_m FROM road_edges WHERE from_node_id=1 AND to_node_id=2",
  );
  assert.equal(moved.distance_m, 500);
});
test("bike date strictness, capacity, retirement and reactivation", async () => {
  for (const date of ["2026-02-30", "2030-01-01", "2026-1-1"])
    await assert.rejects(
      saveBike(pool, admin, { code: "N", zone_id: 1, deployed_at: date }),
    );
  await saveBike(pool, admin, {
    id: 1,
    code: "QX1",
    zone_id: 1,
    status: "RETIRED",
  });
  const [[b]] = await pool.query(
    "SELECT current_zone_id,status FROM bikes WHERE id=1",
  );
  assert.equal(b.current_zone_id, null);
  assert.equal(b.status, "RETIRED");
  await saveBike(pool, admin, {
    id: 1,
    code: "QX1",
    zone_id: 2,
    status: "AVAILABLE",
  });
  await saveBike(pool, admin, { code: "QX3", zone_id: 2 });
  await assert.rejects(saveBike(pool, admin, { code: "QX4", zone_id: 2 }), {
    code: "ZONE_FULL",
  });
});
test("active bikes cannot be moved or retired", async () => {
  await startRide(pool, student, { bike_id: 1 });
  await assert.rejects(
    saveBike(pool, admin, {
      id: 1,
      code: "QX1",
      zone_id: 2,
      status: "RETIRED",
    }),
  );
  await reportFault(pool, admin, {
    bike_id: 2,
    fault_type: "BRAKE",
    description: "刹车故障",
  });
  await assert.rejects(
    saveBike(pool, admin, { id: 2, code: "QX2", zone_id: 2 }),
  );
});
test("staff creation hashes password and email collision never promotes student", async () => {
  await assert.rejects(
    saveStaff(pool, admin, staff({ email: "u2@test.local" })),
  );
  const [[u]] = await pool.query("SELECT role FROM users WHERE id=2");
  assert.equal(u.role, "STUDENT");
  const { id } = await saveStaff(pool, admin, staff());
  const [[s]] = await pool.query(
    "SELECT u.* FROM users u JOIN staff s ON s.user_id=u.id WHERE s.id=?",
    [id],
  );
  assert.equal(s.role, "OPERATOR");
  assert.ok(await bcrypt.compare("Qingxing2026!", s.password_hash));
  await saveStaff(
    pool,
    admin,
    staff({ id, name: "改名", password: undefined }),
  );
  const [[updated]] = await pool.query("SELECT name FROM users WHERE id=?", [
    s.id,
  ]);
  assert.equal(updated.name, "改名");
});
test("assigned work blocks off duty, incompatible job changes and suspension", async () => {
  await createDispatch(pool, admin, {
    source_zone_id: 1,
    target_zone_id: 2,
    bike_ids: [1],
    staff_id: 1,
  });
  const data = staff({
    id: 1,
    name: "测试3",
    phone: "13800000003",
    email: "u3@test.local",
    password: undefined,
  });
  await assert.rejects(saveStaff(pool, admin, { ...data, status: "OFF_DUTY" }));
  await assert.rejects(saveStaff(pool, admin, { ...data, job: "MAINTENANCE" }));
  await assert.rejects(setUserStatus(pool, admin, 3, { status: "SUSPENDED" }));
});
test("suspend cannot block active ride or self; plain student status can change", async () => {
  await assert.rejects(setUserStatus(pool, admin, 1, { status: "SUSPENDED" }));
  await startRide(pool, student, { bike_id: 1 });
  await assert.rejects(setUserStatus(pool, admin, 2, { status: "SUSPENDED" }));
  await setUserStatus(pool, admin, 3, { status: "SUSPENDED" });
  const [[u]] = await pool.query("SELECT status,role FROM users WHERE id=3");
  assert.equal(u.status, "SUSPENDED");
  assert.equal(u.role, "OPERATOR");
});
test("dispatch locks prevent bike edits and reserved slots reject new bikes", async () => {
  await createDispatch(pool, admin, {
    source_zone_id: 1,
    target_zone_id: 2,
    bike_ids: [1, 2],
    staff_id: 1,
  });
  await assert.rejects(
    saveBike(pool, admin, {
      id: 1,
      code: "QX1",
      zone_id: 1,
      status: "RETIRED",
    }),
  );
  await assert.rejects(saveBike(pool, admin, { code: "N", zone_id: 2 }), {
    code: "ZONE_FULL",
  });
});
test("unpaid suspension denied and user update cannot escalate role", async () => {
  const { id } = await startRide(pool, student, { bike_id: 1 });
  await returnRide(pool, student, id, { zone_id: 2, x: 500, y: 100 });
  await assert.rejects(setUserStatus(pool, admin, 2, { status: "SUSPENDED" }));
  await setUserStatus(pool, admin, 2, { status: "ACTIVE", role: "ADMIN" });
  const [[u]] = await pool.query("SELECT role FROM users WHERE id=2");
  assert.equal(u.role, "STUDENT");
});
test("assigned maintenance blocks off duty and job changes; duplicate phone rolls back", async () => {
  const { id } = await reportFault(pool, student, {
    bike_id: 1,
    fault_type: "TIRE",
    description: "轮胎损坏",
  });
  await maintenanceAction(pool, admin, id, "assign", { staff_id: 1 });
  const d = staff({
    id: 1,
    name: "测试3",
    phone: "13800000003",
    email: "u3@test.local",
    password: undefined,
  });
  await assert.rejects(saveStaff(pool, admin, { ...d, status: "OFF_DUTY" }));
  await assert.rejects(saveStaff(pool, admin, { ...d, job: "DISPATCH" }));
  await assert.rejects(saveStaff(pool, admin, { ...d, phone: "13800000002" }), {
    code: "DUPLICATE",
  });
  const [[u]] = await pool.query("SELECT phone FROM users WHERE id=3");
  assert.equal(u.phone, "13800000003");
});
