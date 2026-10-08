import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { createPool } from "../server/db.mjs";
import { applySchema } from "../scripts/sql.mjs";
import { createApp } from "../server/app.mjs";
const pool = createPool({
  database: "campus_bike_test",
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
let server, base, studentCookie, adminCookie;
async function request(path, body, cookie, extra = {}) {
  const r = await fetch(base + path, {
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    },
    ...(body !== undefined
      ? { method: "POST", body: JSON.stringify(body) }
      : {}),
  });
  return {
    status: r.status,
    data: await r.json(),
    cookie: r.headers.get("set-cookie"),
  };
}
before(async () => {
  await applySchema(pool);
  const c = await pool.getConnection();
  try {
    const [[{ name }]] = await c.query("SELECT DATABASE() name");
    assert.equal(name, "campus_bike_test");
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
    "INSERT INTO users(id,name,email,phone,password_hash,role) VALUES(1,'管理员','admin@http.local','13900000001',?,'ADMIN'),(2,'学生','student@http.local','13900000002',?,'STUDENT'),(3,'另一学生','other@http.local','13900000003',?,'STUDENT')",
    [hash, hash, hash],
  );
  await pool.query(
    "INSERT INTO parking_zones(id,name,location,x,y,radius,capacity) VALUES(1,'测试起点','北',100,100,40,10),(2,'测试终点','南',500,100,40,10)",
  );
  await pool.query(
    "INSERT INTO bikes(id,code,deployed_at,current_zone_id) VALUES(1,'HTTP-01','2026-01-01',1),(2,'HTTP-02','2026-01-01',1)",
  );
  await pool.query(
    "INSERT INTO road_nodes(id,name,x,y,zone_id) SELECT id,name,x,y,id FROM parking_zones",
  );
  await pool.query(
    "INSERT INTO road_edges(from_node_id,to_node_id,distance_m) VALUES(1,2,400)",
  );
  server = createApp(pool).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
  studentCookie = (
    await request("/api/auth/login", {
      email: "student@http.local",
      password: "Qingxing2026!",
    })
  ).cookie.split(";")[0];
  adminCookie = (
    await request("/api/auth/login", {
      email: "admin@http.local",
      password: "Qingxing2026!",
    })
  ).cookie.split(";")[0];
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});
test("health identifies campus bike and protected routes need login", async () => {
  assert.equal((await request("/api/health")).data.system, "campus-bike");
  assert.equal((await request("/api/dashboard")).status, 401);
});
test("session uses HttpOnly SameSite and login never returns password hash", async () => {
  const r = await request("/api/auth/login", {
    email: "student@http.local",
    password: "Qingxing2026!",
  });
  assert.match(r.cookie, /HttpOnly/);
  assert.match(r.cookie, /SameSite=Strict/);
  assert.equal(r.data.user.password_hash, undefined);
  assert.equal(
    (
      await request("/api/auth/login", {
        email: "student@http.local",
        password: "bad",
      })
    ).status,
    401,
  );
});
test("registration cannot choose admin role; duplicate phone rejected", async () => {
  const r = await request("/api/auth/register", {
    name: "新同学",
    email: "new@http.local",
    phone: "13900000004",
    password: "Qingxing2026!",
    role: "ADMIN",
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, "STUDENT");
  assert.equal(
    (
      await request("/api/auth/register", {
        name: "其他",
        email: "new2@http.local",
        phone: "13900000004",
        password: "Qingxing2026!",
      })
    ).status,
    409,
  );
});
test("students cannot list users or mutate administrator resources", async () => {
  assert.equal(
    (await request("/api/admin/users", undefined, studentCookie)).status,
    403,
  );
  assert.equal(
    (await request("/api/admin/zones", {}, studentCookie)).status,
    403,
  );
  assert.equal(
    (await request("/api/analytics?days=7", undefined, studentCookie)).status,
    403,
  );
  assert.equal(
    (await request("/api/admin/roads", undefined, studentCookie)).status,
    403,
  );
  assert.equal(
    (await request("/api/admin/users", undefined, adminCookie)).data.users
      .length,
    4,
  );
});
test("cross origin writes rejected before mutation", async () => {
  const r = await request("/api/rides/start", { bike_id: 1 }, studentCookie, {
    origin: "https://untrusted.example",
  });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "INVALID_ORIGIN");
});
test("HTTP lifecycle has private orders and one payment", async () => {
  const started = await request(
    "/api/rides/start",
    { bike_id: 1 },
    studentCookie,
  );
  assert.equal(started.status, 201);
  const id = started.data.id;
  const adminView = await request("/api/dashboard", undefined, adminCookie);
  assert.equal(adminView.data.rides.length, 0);
  const bad = await request(
    "/api/rides/" + id + "/return",
    { zone_id: 2, x: 0, y: 0 },
    studentCookie,
  );
  assert.equal(bad.data.code, "OUTSIDE_FENCE");
  assert.equal(
    (
      await request(
        "/api/rides/" + id + "/return",
        { zone_id: 2, x: 500, y: 100 },
        studentCookie,
      )
    ).data.distance_m,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/rides/" + id + "/pay",
        { idempotency_key: "http-pay-unique" },
        studentCookie,
      )
    ).data.duplicate,
    false,
  );
  assert.equal(
    (
      await request(
        "/api/rides/" + id + "/pay",
        { idempotency_key: "http-pay-unique" },
        studentCookie,
      )
    ).data.duplicate,
    true,
  );
  const d = (await request("/api/dashboard", undefined, studentCookie)).data;
  assert.equal(d.carbon.points, 4);
  assert.equal(d.staff.length, 0);
  assert.equal(d.attempts.length, 1);
});
test("route API validates modes and schema endpoint reflects real objects", async () => {
  assert.equal(
    (
      await request(
        "/api/routes?from=1&to=2&mode=shortest",
        undefined,
        studentCookie,
      )
    ).data.distance_m,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/routes?from=1&to=2&mode=invalid",
        undefined,
        studentCookie,
      )
    ).status,
    400,
  );
  const s = (await request("/api/schema", undefined, studentCookie)).data;
  assert.equal(s.entities.length, 18);
  assert.equal(s.relationships.length, 11);
  assert.equal(s.objects.views.length, 4);
  assert.ok(Object.values(s.objects).every(Array.isArray));
});
test("SQL constraints enforce foreign keys, active ride uniqueness and payment amount", async () => {
  await assert.rejects(
    pool.query(
      "INSERT INTO bikes(code,deployed_at,current_zone_id) VALUES('BAD-FK','2026-01-01',9999)",
    ),
    { code: "ER_NO_REFERENCED_ROW_2" },
  );
  const [r] = await pool.query(
    "INSERT INTO ride_orders(user_id,bike_id,start_zone_id) VALUES(3,2,1)",
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO ride_orders(user_id,bike_id,start_zone_id) VALUES(3,1,1)",
    ),
    { code: "ER_DUP_ENTRY" },
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO payments(order_id,idempotency_key,amount_cents) VALUES(?,'bad-amount',100)",
      [r.insertId],
    ),
    { code: "ER_SIGNAL_EXCEPTION" },
  );
});
