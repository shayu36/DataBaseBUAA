import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
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
test("only fingerprinted build assets receive immutable caching", async () => {
  const assets = new URL("../dist/assets/", import.meta.url);
  await mkdir(assets, { recursive: true });
  const prefix = `cache-test-${randomBytes(8).toString("hex")}`;
  const hashed = `${prefix}-AbCd1234.js`;
  const plain = `${prefix}.js`;
  const files = [hashed, plain].map((name) =>
    fileURLToPath(new URL(name, assets)),
  );
  const created = [];
  try {
    for (const file of files) {
      await writeFile(file, "asset", { flag: "wx" });
      created.push(file);
    }
    const stable = await fetch(`${base}/assets/${hashed}`, { method: "HEAD" });
    assert.equal(stable.status, 200);
    assert.match(stable.headers.get("cache-control"), /max-age=31536000/);
    assert.match(stable.headers.get("cache-control"), /immutable/);
    const ordinary = await fetch(`${base}/assets/${plain}`, { method: "HEAD" });
    assert.equal(ordinary.status, 200);
    assert.doesNotMatch(ordinary.headers.get("cache-control"), /immutable/);
    const apiResponse = await fetch(`${base}/api/health`);
    assert.equal(apiResponse.headers.get("cache-control"), "no-store");
  } finally {
    await Promise.all(
      created.map((file) =>
        unlink(file).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        }),
      ),
    );
  }
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

test("administrators can paginate and update older user accounts", async () => {
  const [[{ baseline }]] = await pool.query(
    "SELECT COUNT(*) AS baseline FROM users",
  );
  const [inserted] = await pool.query(
    "INSERT INTO users(name,email,phone,password_hash) WITH RECURSIVE n AS (SELECT 1 AS value UNION ALL SELECT value+1 FROM n WHERE value<205) SELECT CONCAT('分页用户',value),CONCAT('pagination-',value,'@http.local'),CONCAT('136',LPAD(value,8,'0')),'hash' FROM n",
  );
  const firstId = inserted.insertId;
  const lastId = firstId + inserted.affectedRows - 1;
  try {
    assert.equal(
      (await request("/api/admin/users", undefined, studentCookie)).status,
      403,
    );
    assert.equal(
      (await request("/api/admin/users?before=0", undefined, adminCookie))
        .status,
      400,
    );
    const first = await request("/api/admin/users", undefined, adminCookie);
    assert.equal(first.data.users.length, 100);
    assert.equal(first.data.next_before, first.data.users.at(-1).id);
    const second = await request(
      `/api/admin/users?before=${first.data.next_before}`,
      undefined,
      adminCookie,
    );
    assert.equal(second.data.users.length, 100);
    const third = await request(
      `/api/admin/users?before=${second.data.next_before}`,
      undefined,
      adminCookie,
    );
    assert.equal(third.data.users.length, baseline + 5);
    assert.equal(third.data.next_before, null);
    const ids = [
      ...first.data.users,
      ...second.data.users,
      ...third.data.users,
    ].map((user) => user.id);
    const [expected] = await pool.query(
      "SELECT id FROM users ORDER BY id DESC",
    );
    assert.deepEqual(
      ids,
      expected.map((row) => row.id),
    );
    assert.equal(new Set(ids).size, baseline + 205);
    const older = second.data.users[0].id;
    assert.equal(
      (
        await request(
          `/api/admin/users/${older}/status`,
          { status: "SUSPENDED" },
          adminCookie,
        )
      ).status,
      200,
    );
    const refreshed = await request(
      `/api/admin/users?before=${first.data.next_before}`,
      undefined,
      adminCookie,
    );
    assert.equal(
      refreshed.data.users.find((user) => user.id === older).status,
      "SUSPENDED",
    );
  } finally {
    await pool.query(
      "DELETE FROM audit_logs WHERE action='USER_STATUS' AND entity_id BETWEEN ? AND ?",
      [firstId, lastId],
    );
    await pool.query("DELETE FROM users WHERE id BETWEEN ? AND ?", [
      firstId,
      lastId,
    ]);
  }
});

test("compressed JSON with trailing bytes does not stop the HTTP service", async () => {
  const body = Buffer.concat([
    gzipSync("{}"),
    Buffer.from([0]),
    Buffer.alloc(100 * 1024, 0x58),
  ]);
  const response = await fetch(base + "/api/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    body,
  });
  assert.ok([200, 400].includes(response.status));
  await response.arrayBuffer();
  await delay(250);
  assert.equal((await request("/api/health")).status, 200);
});

test("malformed compression and unsupported encodings report client errors", async () => {
  for (const [headers, body, status, code] of [
    [
      { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      Buffer.from("invalid gzip"),
      400,
      "INVALID_COMPRESSED_BODY",
    ],
    [
      { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      gzipSync("{}").subarray(0, 12),
      400,
      "INVALID_COMPRESSED_BODY",
    ],
    [
      { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      gzipSync("{invalid json"),
      400,
      "INVALID_JSON",
    ],
    [
      { "Content-Type": "application/json", "Content-Encoding": "deflate" },
      Buffer.from("invalid deflate"),
      400,
      "INVALID_COMPRESSED_BODY",
    ],
    [
      { "Content-Type": "application/json", "Content-Encoding": "br" },
      Buffer.from("invalid brotli"),
      400,
      "INVALID_COMPRESSED_BODY",
    ],
    [
      { "Content-Type": "application/json", "Content-Encoding": "unsupported" },
      "{}",
      415,
      "UNSUPPORTED_CONTENT_ENCODING",
    ],
    [
      { "Content-Type": "application/json; charset=iso-8859-1" },
      "{}",
      415,
      "UNSUPPORTED_CHARSET",
    ],
  ]) {
    const response = await fetch(base + "/api/auth/logout", {
      method: "POST",
      headers,
      body,
    });
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
  }
  assert.equal((await request("/api/health")).status, 200);
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
test("legacy short passwords can authenticate but cannot be used for registration", async () => {
  const hash = await bcrypt.hash("abc1", 4);
  await pool.query(
    "INSERT INTO users(name,email,phone,password_hash,role) VALUES('旧账号','legacy@http.local','13900000999',?,'STUDENT')",
    [hash],
  );
  try {
    const login = await request("/api/auth/login", {
      email: "legacy@http.local",
      password: "abc1",
    });
    assert.equal(login.status, 200);
    const registered = await request("/api/auth/register", {
      name: "新账号",
      email: "new-short@http.local",
      phone: "13900000998",
      password: "abc1",
    });
    assert.equal(registered.status, 400);
  } finally {
    await pool.query("DELETE FROM users WHERE email='legacy@http.local'");
  }
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
test("same-site writes from another local port are rejected", async () => {
  for (const origin of ["http://127.0.0.1:5189", "http://localhost:5189"]) {
    const result = await request("/api/auth/logout", {}, studentCookie, {
      origin,
      "sec-fetch-site": "same-site",
    });
    assert.equal(result.status, 403);
    assert.equal(result.data.code, "INVALID_ORIGIN");
    assert.equal(result.cookie, null);
  }
  const sameOrigin = await request("/api/auth/logout", {}, studentCookie, {
    origin: base,
    "sec-fetch-site": "same-origin",
  });
  assert.equal(sameOrigin.status, 200);
});
test("development proxy preserves the browser origin for writes", async () => {
  const { createServer, loadConfigFromFile } = await import("vite");
  const configPath = fileURLToPath(
    new URL("../frontend/vite.config.ts", import.meta.url),
  );
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    configPath,
  );
  const configured = loaded.config.server.proxy["/api"];
  const proxy =
    typeof configured === "string" ? base : { ...configured, target: base };
  const vite = await createServer({
    configFile: false,
    root: loaded.config.root,
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: { "/api": proxy },
    },
  });
  try {
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const response = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        email: "student@http.local",
        password: "Qingxing2026!",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.id, 2);
  } finally {
    await vite.close();
  }
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
  const noGpsTime = await request(
    "/api/rides/" + id + "/return",
    { zone_id: 2, x: 500, y: 100, location_source: "DEVICE_GPS" },
    studentCookie,
  );
  assert.equal(noGpsTime.status, 400);
  assert.equal(noGpsTime.data.code, "LOCATION_TIMESTAMP_REQUIRED");
  const nullGpsTime = await request(
    "/api/rides/" + id + "/return",
    {
      zone_id: 2,
      x: 500,
      y: 100,
      captured_at: null,
      location_source: "DEVICE_GPS",
    },
    studentCookie,
  );
  assert.equal(nullGpsTime.status, 400);
  assert.equal(nullGpsTime.data.code, "LOCATION_TIMESTAMP_REQUIRED");
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
  const differentKey = await request(
    "/api/rides/" + id + "/pay",
    { idempotency_key: "http-pay-different" },
    studentCookie,
  );
  assert.equal(differentKey.status, 409);
  assert.equal(differentKey.data.code, "ORDER_ALREADY_PAID");
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
  assert.equal((await request("/api/road-graph")).status, 401);
  await pool.query(
    "UPDATE road_edges SET status='CLOSED' WHERE from_node_id=1 AND to_node_id=2",
  );
  try {
    const graph = await request("/api/road-graph", undefined, studentCookie);
    assert.equal(graph.status, 200);
    assert.equal(graph.data.nodes.length, 2);
    assert.equal(graph.data.edges[0].status, "CLOSED");
  } finally {
    await pool.query(
      "UPDATE road_edges SET status='OPEN' WHERE from_node_id=1 AND to_node_id=2",
    );
  }
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

test("route API returns travel-oriented segments for reverse roads", async () => {
  const [[original]] = await pool.query(
    "SELECT slope_percent,direction FROM road_edges WHERE id=1",
  );
  try {
    await pool.query(
      "UPDATE road_edges SET slope_percent=2.25,direction='REVERSE' WHERE id=1",
    );
    const response = await request(
      "/api/routes?from=2&to=1&mode=comfortable",
      undefined,
      studentCookie,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.path, [2, 1]);
    const [segment] = response.data.segments;
    assert.deepEqual(
      {
        from: segment.from_node_id,
        to: segment.to_node_id,
        roadFrom: segment.road_from_node_id,
        roadTo: segment.road_to_node_id,
        direction: segment.direction,
        slope: segment.slope_percent,
      },
      {
        from: 2,
        to: 1,
        roadFrom: 1,
        roadTo: 2,
        direction: "REVERSE",
        slope: -2.25,
      },
    );
    assert.equal(
      (await request("/api/routes?from=1&to=2", undefined, studentCookie))
        .status,
      409,
    );
  } finally {
    await pool.query(
      "UPDATE road_edges SET slope_percent=?,direction=? WHERE id=1",
      [original.slope_percent, original.direction],
    );
  }
});

test("route API returns all three alternatives consistently with single modes", async () => {
  const all = await request(
    "/api/routes?from=2&to=1&mode=all",
    undefined,
    studentCookie,
  );
  assert.equal(all.status, 200);
  for (const mode of ["shortest", "safe", "comfortable"]) {
    const single = await request(
      `/api/routes?from=2&to=1&mode=${mode}`,
      undefined,
      studentCookie,
    );
    assert.equal(single.status, 200);
    const { nodes, edges, ...details } = single.data;
    assert.deepEqual(all.data.nodes, nodes);
    assert.deepEqual(all.data.edges, edges);
    assert.deepEqual(all.data.routes[mode], details);
  }
  const same = await request(
    "/api/routes?from=1&to=1&mode=all",
    undefined,
    studentCookie,
  );
  for (const mode of ["shortest", "safe", "comfortable"]) {
    assert.deepEqual(same.data.routes[mode].path, [1]);
    assert.equal(same.data.routes[mode].distance_m, 0);
  }
  const [[original]] = await pool.query(
    "SELECT status FROM road_edges WHERE id=1",
  );
  try {
    await pool.query("UPDATE road_edges SET status='CLOSED' WHERE id=1");
    const unavailable = await request(
      "/api/routes?from=1&to=2&mode=all",
      undefined,
      studentCookie,
    );
    assert.equal(unavailable.status, 409);
    assert.equal(unavailable.data.code, "NO_ROUTE");
  } finally {
    await pool.query("UPDATE road_edges SET status=? WHERE id=1", [
      original.status,
    ]);
  }
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

test("dispatch suggestion can be confirmed without an optional request body", async () => {
  await pool.query(
    "INSERT INTO bikes(code,deployed_at,current_zone_id) VALUES('HTTP-OPTIONAL-BODY','2026-01-01',1)",
  );
  const [suggestion] = await pool.query(`INSERT INTO dispatch_suggestions
    (source_zone_id,target_zone_id,quantity,source_available,target_occupied,target_capacity,target_reserved,borrow_count,return_count,desired_inventory,window_start,window_end,reason,algorithm_version,created_by)
    VALUES(1,2,1,1,0,10,0,0,0,1,'2026-01-01','2026-01-02','测试可选请求体','test',1)`);
  const response = await fetch(
    `${base}/api/dispatches/from-suggestion/${suggestion.insertId}`,
    { method: "POST", headers: { Cookie: adminCookie } },
  );
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.suggestion_id, suggestion.insertId);
  const [[saved]] = await pool.query(
    "SELECT s.status,t.staff_id,t.status task_status FROM dispatch_suggestions s JOIN dispatch_tasks t ON t.id=s.task_id WHERE s.id=?",
    [suggestion.insertId],
  );
  assert.deepEqual(saved, {
    status: "CONFIRMED",
    staff_id: null,
    task_status: "PENDING",
  });
});
