import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { createPool } from "../backend/db.mjs";
import { seedDemo, seedSimulation } from "../backend/demo-seed.mjs";
import { applySchema } from "../scripts/sql.mjs";
import { dashboard } from "../backend/read-model.mjs";
import { createApp } from "../backend/app.mjs";

test("simulation data imports 123 users and 200 bikes atomically without replacing existing records", async () => {
  const suffix = randomBytes(4).toString("hex");
  const database = `campus_bike_simulation_${suffix}`;
  const username = `q_sim_${suffix}`;
  const password = randomBytes(24).toString("hex");
  const credentials = {
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  };
  const admin = createPool({ ...credentials, database: undefined });
  let db,
    app,
    server,
    created = false,
    userCreated = false;
  const snapshot = async () => {
    const result = {};
    for (const table of [
      "users",
      "bikes",
      "parking_zones",
      "ride_orders",
      "payments",
      "carbon_transactions",
      "audit_logs",
      "system_settings",
    ])
      [result[table]] = await db.query(
        `SELECT * FROM \`${table}\` ORDER BY ${table === "system_settings" ? "name" : "id"}`,
      );
    return result;
  };
  try {
    await admin.query(
      "CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
      [database],
    );
    created = true;
    await admin.query("CREATE USER ?@'localhost' IDENTIFIED BY ?", [
      username,
      password,
    ]);
    userCreated = true;
    await admin.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE,EXECUTE ON \`${database}\`.* TO '${username}'@'localhost'`,
    );
    db = createPool({ ...credentials, database });
    app = createPool({ database, user: username, password });
    await applySchema(db);
    await seedDemo(app, db);
    const original = await snapshot();
    assert.equal(original.users.length, 4);
    assert.equal(original.bikes.length, 66);

    await db.query(
      "INSERT INTO users(id,name,email,phone,password_hash) VALUES(5,'已有账号','existing@test.local','13999999999','test')",
    );
    const conflict = await snapshot();
    await assert.rejects(seedSimulation(app, db), {
      sqlMessage: "SIMULATION_USER_CONFLICT",
    });
    assert.deepEqual(await snapshot(), conflict);
    await db.query("DELETE FROM users WHERE id=5");
    await db.query("UPDATE parking_zones SET status='CLOSED' WHERE id=1");
    const closed = await snapshot();
    await assert.rejects(seedSimulation(app, db), {
      sqlMessage: "SIMULATION_ZONE_UNAVAILABLE",
    });
    assert.deepEqual(await snapshot(), closed);
    await db.query("UPDATE parking_zones SET status='ACTIVE' WHERE id=1");

    await db.query(
      "CREATE TRIGGER simulation_failure BEFORE INSERT ON bikes FOR EACH ROW BEGIN IF NEW.id=120 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SIMULATION_TEST_FAILURE'; END IF; END",
    );
    await assert.rejects(seedSimulation(app, db), {
      sqlMessage: "SIMULATION_TEST_FAILURE",
    });
    assert.deepEqual(await snapshot(), original);
    await db.query("DROP TRIGGER simulation_failure");

    assert.deepEqual(await seedSimulation(app, db), {
      users_created: 119,
      bikes_created: 134,
      users: 123,
      bikes: 200,
    });
    const expanded = await snapshot();
    assert.equal(expanded.users.length, 123);
    assert.equal(expanded.bikes.length, 200);
    assert.deepEqual(
      expanded.users.filter((r) => r.id <= 4),
      original.users,
    );
    assert.deepEqual(
      expanded.bikes.filter((r) => r.id <= 66),
      original.bikes,
    );
    for (const table of ["ride_orders", "payments", "carbon_transactions"])
      assert.deepEqual(expanded[table], original[table]);
    assert.ok(
      await bcrypt.compare(
        "Qingxing2026!",
        expanded.users.find((r) => r.id === 5).password_hash,
      ),
    );
    assert.ok(
      expanded.parking_zones.some(
        (z, i) => z.capacity > original.parking_zones[i].capacity,
      ),
    );
    assert.equal(
      expanded.bikes.filter((b) => b.id > 66 && b.current_zone_id === 2).length,
      0,
    );
    const user = expanded.users.find((r) => r.id === 5);
    const result = await dashboard(app, user);
    assert.equal(result.bikes.length, 200);
    assert.equal(result.summary.total_bikes, 200);
    const [checks] = await db.query(
      await readFile(
        new URL("../database/invariant-checks.sql", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(checks.length, 15);
    assert.deepEqual(
      checks.filter((r) => Number(r.errors) !== 0),
      [],
    );
    assert.deepEqual(await seedSimulation(app, db), {
      users_created: 0,
      bikes_created: 0,
      users: 123,
      bikes: 200,
    });
    assert.deepEqual(await snapshot(), expanded);
    const [[{ routines }]] = await db.query(
      "SELECT COUNT(*) routines FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()",
    );
    assert.equal(routines, 39);

    server = createApp(app).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(path, body, cookie) {
      const response = await fetch(base + "/api" + path, {
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body !== undefined
          ? { method: "POST", body: JSON.stringify(body) }
          : {}),
      });
      return {
        status: response.status,
        cookie: response.headers.get("set-cookie")?.split(";")[0],
        data: await response.json(),
      };
    }
    const studentLogin = await request("/auth/login", {
      email: "student119@simulation.qingxing.local",
      password: "Qingxing2026!",
    });
    assert.equal(studentLogin.status, 200);
    assert.equal(studentLogin.data.user.id, 123);
    assert.equal(studentLogin.data.user.role, "STUDENT");
    const studentCookie = studentLogin.cookie;
    const studentDashboard = await request(
      "/dashboard",
      undefined,
      studentCookie,
    );
    assert.equal(studentDashboard.data.summary.total_bikes, 200);
    assert.equal(studentDashboard.data.bikes.length, 200);
    assert.equal(
      (await request("/admin/users?q=student", undefined, studentCookie))
        .status,
      403,
    );

    const adminLogin = await request("/auth/login", {
      email: "jia@qingxing.local",
      password: "Qingxing2026!",
    });
    assert.equal(adminLogin.status, 200);
    const accounts = await request(
      "/admin/users",
      undefined,
      adminLogin.cookie,
    );
    assert.equal(accounts.data.total, 123);
    assert.equal(accounts.data.users.length, 100);
    const found = await request(
      "/admin/users?q=student001%40simulation.qingxing.local",
      undefined,
      adminLogin.cookie,
    );
    assert.equal(found.data.total, 1);
    assert.equal(found.data.users[0].id, 5);

    const bike = studentDashboard.data.bikes.find((row) => row.id === 200);
    assert.equal(bike.status, "AVAILABLE");
    const ride = await request(
      "/rides/start",
      { bike_id: bike.id },
      studentCookie,
    );
    assert.equal(ride.status, 201);
    const returned = await request(
      `/rides/${ride.data.id}/return`,
      {
        zone_id: bike.current_zone_id,
        route_mode: "shortest",
        captured_at: new Date().toISOString(),
        location_source: "MAP_SIMULATION",
      },
      studentCookie,
    );
    assert.equal(returned.status, 200);
    const payment = await request(
      `/rides/${ride.data.id}/pay`,
      { idempotency_key: `simulation-http-${suffix}` },
      studentCookie,
    );
    assert.equal(payment.status, 200);
    const finalDashboard = await request(
      "/dashboard",
      undefined,
      studentCookie,
    );
    assert.equal(
      finalDashboard.data.rides.find((row) => row.id === ride.data.id).status,
      "PAID",
    );
    assert.equal(
      finalDashboard.data.bikes.find((row) => row.id === bike.id).status,
      "AVAILABLE",
    );
    const afterRide = await snapshot();
    await seedSimulation(app, db);
    assert.deepEqual(await snapshot(), afterRide);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (app) await app.end();
    if (db) await db.end();
    if (userCreated) await admin.query("DROP USER ?@'localhost'", [username]);
    if (created) await admin.query("DROP DATABASE ??", [database]);
    await admin.end();
  }
});
