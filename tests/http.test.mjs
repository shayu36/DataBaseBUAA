import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { createPool } from "../backend/db.mjs";
import { applySchema } from "../scripts/sql.mjs";
import { createApp } from "../backend/app.mjs";
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
test("encoded Chinese documentation URLs serve the intended generated files", async () => {
  await import("../scripts/render-report.mjs");
  const diagram = await fetch(base + "/docs/" + encodeURIComponent("ER图.svg"));
  assert.equal(diagram.status, 200);
  assert.match(diagram.headers.get("content-type"), /^image\/svg\+xml/);
  assert.match(await diagram.text(), /<svg\b/);
  const report = await fetch(
    base + "/docs/" + encodeURIComponent("数据库课程设计报告.html"),
  );
  assert.equal(report.status, 200);
  assert.match(report.headers.get("content-type"), /^text\/html/);
  assert.match(await report.text(), /dispatch_suggestions/);
  const authenticated = await fetch(base + "/api/report", {
    headers: { Cookie: studentCookie },
  });
  assert.equal(authenticated.status, 200);
  assert.match(await authenticated.text(), /dispatch_suggestions/);
  for (const path of [
    "/docs/README.md",
    "/docs/..%2FREADME.md",
    "/docs/evidence/report.txt",
  ]) {
    assert.equal((await fetch(base + path)).status, 404);
  }
});

test("invalid carbon configuration reports a clear service error", async () => {
  const [original] = await pool.query(
    "SELECT value FROM system_settings WHERE name='carbon'",
  );
  try {
    await pool.query(
      "INSERT INTO system_settings(name,value) VALUES('carbon',JSON_OBJECT('kg_per_km','0.21abc')) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    );
    const response = await request("/api/dashboard", undefined, studentCookie);
    assert.equal(response.status, 503);
    assert.equal(response.data.code, "INVALID_CARBON_RULE");
    assert.match(response.data.error, /规则配置无效/);
    assert.equal((await request("/api/health")).status, 200);
  } finally {
    if (original.length)
      await pool.query(
        "UPDATE system_settings SET value=? WHERE name='carbon'",
        [JSON.stringify(original[0].value)],
      );
    else await pool.query("DELETE FROM system_settings WHERE name='carbon'");
  }
});

test("carbon rule and ledger preserve precise decimals over HTTP", async () => {
  const [original] = await pool.query(
    "SELECT value FROM system_settings WHERE name='carbon'",
  );
  const [order] = await pool.query(
    "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status) VALUES(2,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),UTC_TIMESTAMP(3),0,100,'UNPAID')",
  );
  try {
    await pool.query(
      "INSERT INTO system_settings(name,value) VALUES('carbon',JSON_OBJECT('kg_per_km','999999999999.99999999','points_per_km','0.00000001')) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    );
    const paid = await request(
      `/api/rides/${order.insertId}/pay`,
      { idempotency_key: "http-precise-rule" },
      studentCookie,
    );
    assert.equal(paid.status, 200);
    const home = await request("/api/dashboard", undefined, studentCookie);
    const history = await request(
      "/api/carbon/entries",
      undefined,
      studentCookie,
    );
    assert.equal(home.data.carbon.rule.kg_per_km, "999999999999.99999999");
    assert.equal(home.data.carbon.rule.points_per_km, "0.00000001");
    for (const entry of [
      home.data.carbon.entries[0],
      history.data.entries[0],
    ]) {
      assert.equal(entry.factor_kg_per_km, "999999999999.99999999");
      assert.equal(entry.points_per_km, "0.00000001");
    }
  } finally {
    await pool.query(
      "DELETE FROM audit_logs WHERE entity_type='ride_orders' AND entity_id=?",
      [order.insertId],
    );
    await pool.query("DELETE FROM carbon_transactions WHERE order_id=?", [
      order.insertId,
    ]);
    await pool.query("DELETE FROM payments WHERE order_id=?", [order.insertId]);
    await pool.query("DELETE FROM ride_orders WHERE id=?", [order.insertId]);
    if (original.length)
      await pool.query(
        "UPDATE system_settings SET value=? WHERE name='carbon'",
        [JSON.stringify(original[0].value)],
      );
    else await pool.query("DELETE FROM system_settings WHERE name='carbon'");
  }
});

test("carbon award overflow returns a useful payment error", async () => {
  const [original] = await pool.query(
    "SELECT value FROM system_settings WHERE name='carbon'",
  );
  const [order] = await pool.query(
    "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status) VALUES(2,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),UTC_TIMESTAMP(3),1000,100,'UNPAID')",
  );
  try {
    await pool.query(
      "INSERT INTO system_settings(name,value) VALUES('carbon',JSON_OBJECT('points_per_km','2147483648')) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    );
    const response = await request(
      `/api/rides/${order.insertId}/pay`,
      { idempotency_key: "http-overflow" },
      studentCookie,
    );
    assert.equal(response.status, 503);
    assert.equal(response.data.code, "CARBON_AWARD_OUT_OF_RANGE");
    assert.match(response.data.error, /超出系统范围/);
  } finally {
    await pool.query("DELETE FROM ride_orders WHERE id=?", [order.insertId]);
    if (original.length)
      await pool.query(
        "UPDATE system_settings SET value=? WHERE name='carbon'",
        [JSON.stringify(original[0].value)],
      );
    else await pool.query("DELETE FROM system_settings WHERE name='carbon'");
  }
});

test("carbon adjustment rejects excess precision through the API", async () => {
  const [order] = await pool.query(
    "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status) VALUES(2,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),UTC_TIMESTAMP(3),1000,100,'UNPAID')",
  );
  try {
    const payment = await request(
      `/api/rides/${order.insertId}/pay`,
      { idempotency_key: "precision-http-payment" },
      studentCookie,
    );
    assert.equal(payment.status, 200);
    const response = await request(
      "/api/carbon/adjustments",
      {
        order_id: order.insertId,
        points_change: 1,
        carbon_kg_change: 0.00001,
        reason: "精度校验",
        idempotency_key: "precision-http-adjust",
      },
      adminCookie,
    );
    assert.equal(response.status, 400);
    assert.equal(response.data.code, "INVALID_ADJUSTMENT_AMOUNT");
    const [[{ count }]] = await pool.query(
      "SELECT COUNT(*) AS count FROM carbon_transactions WHERE order_id=? AND entry_type='ADJUSTMENT'",
      [order.insertId],
    );
    assert.equal(count, 0);
  } finally {
    await pool.query(
      "DELETE FROM audit_logs WHERE entity_type='ride_orders' AND entity_id=?",
      [order.insertId],
    );
    await pool.query("DELETE FROM carbon_transactions WHERE order_id=?", [
      order.insertId,
    ]);
    await pool.query("DELETE FROM payments WHERE order_id=?", [order.insertId]);
    await pool.query("DELETE FROM ride_orders WHERE id=?", [order.insertId]);
  }
});

test("administrators paginate and review older qualifying orders", async () => {
  const [inserted] = await pool.query(
    "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status,qualification_status,qualification_reason) WITH RECURSIVE n AS (SELECT 1 AS value UNION ALL SELECT value+1 FROM n WHERE value<205) SELECT 2,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),UTC_TIMESTAMP(3),1000,100,'UNPAID','UNDER_REVIEW','分页测试' FROM n",
  );
  const firstId = inserted.insertId;
  const lastId = firstId + inserted.affectedRows - 1;
  try {
    assert.equal(
      (await request("/api/admin/orders/review", undefined, studentCookie))
        .status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/admin/orders/review?before=0",
          undefined,
          adminCookie,
        )
      ).status,
      400,
    );
    const first = await request(
      "/api/admin/orders/review",
      undefined,
      adminCookie,
    );
    assert.equal(first.status, 200);
    assert.equal(first.data.orders.length, 100);
    assert.equal(first.data.next_before, first.data.orders.at(-1).id);
    const second = await request(
      `/api/admin/orders/review?before=${first.data.next_before}`,
      undefined,
      adminCookie,
    );
    assert.equal(second.data.orders.length, 100);
    const third = await request(
      `/api/admin/orders/review?before=${second.data.next_before}`,
      undefined,
      adminCookie,
    );
    assert.equal(third.data.orders.length, 5);
    assert.equal(third.data.next_before, null);
    const ids = [
      ...first.data.orders,
      ...second.data.orders,
      ...third.data.orders,
    ].map((r) => r.id);
    assert.equal(new Set(ids).size, 205);
    assert.deepEqual(
      ids,
      Array.from({ length: 205 }, (_, i) => lastId - i),
    );
    const older = second.data.orders[0].id;
    const reviewed = await request(
      `/api/orders/${older}/qualification`,
      { decision: "VALID", reason: "分页复核" },
      adminCookie,
    );
    assert.equal(reviewed.status, 200);
    const updated = await request(
      `/api/admin/orders/review?before=${first.data.next_before}`,
      undefined,
      adminCookie,
    );
    assert.equal(updated.data.orders.length, 100);
    assert.ok(!updated.data.orders.some((r) => r.id === older));
    assert.equal(updated.data.orders[0].id, older - 1);
  } finally {
    await pool.query(
      "DELETE FROM audit_logs WHERE action='ORDER_QUALIFICATION' AND entity_id BETWEEN ? AND ?",
      [firstId, lastId],
    );
    await pool.query("DELETE FROM ride_orders WHERE id BETWEEN ? AND ?", [
      firstId,
      lastId,
    ]);
  }
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
test("login rejects passwords exceeding bcrypt's UTF-8 byte limit", async () => {
  const password = "a".repeat(69) + "中";
  const [[original]] = await pool.query(
    "SELECT password_hash FROM users WHERE id=3",
  );
  await pool.query("UPDATE users SET password_hash=? WHERE id=3", [
    await bcrypt.hash(password, 4),
  ]);
  try {
    const valid = await request("/api/auth/login", {
      email: "other@http.local",
      password,
    });
    assert.equal(valid.status, 200);
    const truncated = await request("/api/auth/login", {
      email: "other@http.local",
      password: password + "文",
    });
    assert.equal(truncated.status, 400);
    assert.equal(truncated.cookie, null);
  } finally {
    await pool.query("UPDATE users SET password_hash=? WHERE id=3", [
      original.password_hash,
    ]);
  }
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
test("new students receive an unranked private leaderboard summary", async () => {
  const result = await request(
    "/api/leaderboard?period=week&metric=points",
    undefined,
    studentCookie,
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.me.rank, null);
  assert.equal(result.data.me.private, true);
  assert.equal(result.data.me.rides, 0);
  assert.deepEqual(result.data.rows, []);
});
test("students cannot list users or mutate administrator resources", async () => {
  assert.equal(
    (await request("/api/dispatches?before=1", undefined, studentCookie))
      .status,
    403,
  );
  assert.equal(
    (await request("/api/maintenance?before=invalid", undefined, studentCookie))
      .status,
    400,
  );
  assert.equal(
    (await request("/api/dispatches?before=invalid", undefined, adminCookie))
      .status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/carbon/entries?before=invalid",
        undefined,
        studentCookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/risks?before=1", undefined, studentCookie)).status,
    403,
  );
  assert.equal(
    (await request("/api/risks?before=invalid", undefined, adminCookie)).status,
    400,
  );
  assert.equal(
    (await request("/api/return-attempts?scope=all", undefined, studentCookie))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/return-attempts?before=invalid",
        undefined,
        studentCookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/analytics/suggestions?before=1",
        undefined,
        studentCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/analytics/suggestions?before=invalid",
        undefined,
        adminCookie,
      )
    ).status,
    400,
  );
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
test("analytics rejects invalid and future date ranges as client errors", async () => {
  for (const query of [
    "start=2026-02-30&end=2026-03-01",
    "start=2999-01-01&end=2999-01-02",
    "days=7&start=2026-01-01&end=2026-01-02",
  ]) {
    const response = await request(
      `/api/analytics?${query}`,
      undefined,
      adminCookie,
    );
    assert.equal(response.status, 400);
  }
});
test("preset analytics respects weekday, hour, and zone filters", async () => {
  const query = "days=7&dayType=WEEKDAY&startHour=8&endHour=12&zoneId=1";
  const response = await request(
    `/api/analytics?${query}`,
    undefined,
    adminCookie,
  );
  assert.equal(response.status, 200);
  assert.equal(response.data.hotspots.length, 1);
  assert.equal(response.data.hotspots[0].zone_id, 1);
  assert.equal(response.data.filter.preset, "7");
  assert.equal(response.data.filter.dayType, "WEEKDAY");
  assert.equal(response.data.filter.startHour, 8);
  assert.equal(response.data.filter.endHour, 12);
  assert.equal(response.data.filter.zoneId, 1);
  const saved = await request(
    "/api/analytics/suggestions",
    {
      days: 7,
      dayType: "WEEKDAY",
      startHour: 8,
      endHour: 12,
      zoneId: 1,
    },
    adminCookie,
  );
  assert.equal(saved.status, 201);
  assert.equal(saved.data.filter.zoneId, 1);
  assert.equal(saved.data.filter.dayType, "WEEKDAY");
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
  assert.equal(d.carbon.ride_count, 1);
  const ownEntries = await request(
    "/api/carbon/entries",
    undefined,
    studentCookie,
  );
  const adminEntries = await request(
    "/api/carbon/entries",
    undefined,
    adminCookie,
  );
  assert.equal(ownEntries.data.entries.length, 1);
  assert.equal(ownEntries.data.entries[0].order_id, id);
  assert.deepEqual(adminEntries.data.entries, []);
  assert.equal(d.staff.length, 0);
  assert.equal(d.attempts.length, 1);
});
test("ride CSV exports all filtered personal orders and protects spreadsheet cells", async () => {
  const [[original]] = await pool.query("SELECT code FROM bikes WHERE id=1");
  const [created] =
    await pool.query(`INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,amount_cents,distance_m,status)
    WITH RECURSIVE n AS (SELECT 1 AS value UNION ALL SELECT value+1 FROM n WHERE value<105)
    SELECT 2,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),UTC_TIMESTAMP(3),100,400,'UNPAID' FROM n`);
  const [other] = await pool.query(
    "INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,amount_cents,distance_m,status) VALUES(3,1,1,2,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),UTC_TIMESTAMP(3),100,400,'UNPAID')",
  );
  try {
    await pool.query("UPDATE bikes SET code=? WHERE id=1", ["  =DANGEROUS"]);
    const response = await fetch(base + "/api/rides/export.csv?status=UNPAID", {
      headers: { Cookie: studentCookie },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition"), /attachment/);
    const lines = (await response.text()).trim().split(/\r?\n/);
    assert.equal(lines.length, 106);
    assert.ok(
      lines.slice(1).every((line) => line.includes('"\'  =DANGEROUS"')),
    );
    assert.ok(
      lines.slice(1).every((line) => !line.startsWith(`"${other.insertId}",`)),
    );
    const first = await request(
      "/api/rides?status=UNPAID",
      undefined,
      studentCookie,
    );
    const second = await request(
      `/api/rides?status=UNPAID&before=${first.data.next_before}`,
      undefined,
      studentCookie,
    );
    assert.equal(first.data.rides.length, 100);
    assert.equal(second.data.rides.length, 5);
    assert.equal(
      (await request("/api/rides?status=INVALID", undefined, studentCookie))
        .status,
      400,
    );
  } finally {
    await pool.query("UPDATE bikes SET code=? WHERE id=1", [original.code]);
    await pool.query("DELETE FROM ride_orders WHERE id>=? AND id<=?", [
      created.insertId,
      other.insertId,
    ]);
  }
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
