import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { createPool, ledgerTransaction } from "../backend/db.mjs";
import { upgradeCampusMap } from "../backend/campus.mjs";
import { seedDemo } from "../backend/demo-seed.mjs";
import { applySchema } from "../scripts/sql.mjs";
import { hotspotDemand, hotspotReport } from "../backend/hotspot-report.mjs";
import { aggregateHotspots } from "./hotspot-reference.mjs";
import { dispatchSuggestions as expectedSuggestions } from "./dispatch-reference.mjs";
import { dispatchSuggestions } from "../backend/dispatch-suggestions.mjs";

test("schema initialization holds its database lock through DDL", async () => {
  const database = `campus_bike_schema_test_${randomBytes(4).toString("hex")}`;
  const credentials = {
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  };
  const admin = createPool({ ...credentials, database: undefined });
  let pool,
    observer,
    created = false;
  const checked = new Set();
  try {
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    pool = createPool({ ...credentials, database });
    observer = createPool({ ...credentials, database });
    const inspect = async (statement, connectionId) => {
      const marker = [
        "CREATE TABLE IF NOT EXISTS users",
        "CREATE TRIGGER trg_payment_guard",
        "CREATE PROCEDURE sp_dashboard",
      ].find((prefix) => statement.startsWith(prefix));
      if (marker && !checked.has(marker)) {
        const [[row]] = await observer.query(
          "SELECT IS_USED_LOCK(CONCAT('campus-bike:', DATABASE())) AS owner",
        );
        assert.equal(row.owner, connectionId, `${marker} 必须由持锁连接执行`);
        const [[schema]] = await observer.query(
          "SELECT IS_USED_LOCK(CONCAT('campus-bike:schema:',DATABASE())) AS owner",
        );
        assert.equal(schema.owner, connectionId, `${marker} 必须持有结构锁`);
        const [[contender]] = await observer.query(
          "SELECT GET_LOCK(CONCAT('campus-bike:', DATABASE()),0) AS acquired",
        );
        assert.equal(contender.acquired, 0);
        checked.add(marker);
      }
    };
    const guardedPool = {
      async getConnection() {
        const connection = await pool.getConnection();
        return new Proxy(connection, {
          get(target, property) {
            if (property === "query")
              return async (statement, ...args) => {
                await inspect(statement, target.threadId);
                return target.query(statement, ...args);
              };
            const value = target[property];
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      async query(statement, ...args) {
        await inspect(statement);
        return pool.query(statement, ...args);
      },
    };
    await applySchema(guardedPool);
    assert.equal(checked.size, 3);
    const [[after]] = await observer.query(
      "SELECT IS_USED_LOCK(CONCAT('campus-bike:', DATABASE())) AS owner",
    );
    assert.equal(after.owner, null);
  } finally {
    if (observer) await observer.end();
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

test("SQL seed is atomic, repeatable and retains the expected demo data", async () => {
  const database = `campus_bike_seed_test_${randomBytes(4).toString("hex")}`;
  const username = `seedtest_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const credentials = {
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  };
  const admin = createPool({ ...credentials, database: undefined });
  let pool;
  let appPool;
  let created = false;
  let userCreated = false;
  try {
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    pool = createPool({ ...credentials, database });
    await applySchema(pool);
    await admin.query(`CREATE USER '${username}'@'localhost' IDENTIFIED BY ?`, [
      password,
    ]);
    userCreated = true;
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON \`${database}\`.* TO '${username}'@'localhost'`,
    );
    appPool = createPool({ database, user: username, password });
    const guardedActions = [];
    const guardedAdmin = {
      async getConnection() {
        const connection = await pool.getConnection();
        return {
          async query(statement, ...args) {
            const action = statement.includes("CREATE PROCEDURE")
              ? "create"
              : statement.startsWith("DROP PROCEDURE")
                ? "drop"
                : null;
            if (action) {
              const [[{ available }]] = await pool.query(
                "SELECT IS_FREE_LOCK(CONCAT('campus-bike:schema:',DATABASE())) AS available",
              );
              assert.equal(available, 0, `演示过程${action}时必须持有数据库锁`);
              guardedActions.push(action);
            }
            return connection.query(statement, ...args);
          },
          release() {
            connection.release();
          },
        };
      },
    };
    assert.equal(await seedDemo(appPool, guardedAdmin), true);
    assert.deepEqual(guardedActions, ["create", "drop"]);
    const [[counts]] = await pool.query(
      "SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM bikes) bikes, (SELECT COUNT(*) FROM parking_zones) zones, (SELECT COUNT(*) FROM ride_orders) rides, (SELECT COUNT(*) FROM payments) payments, (SELECT COUNT(*) FROM carbon_transactions) credits",
    );
    assert.equal(counts.users, 4);
    assert.equal(counts.bikes, 66);
    assert.equal(counts.zones, 6);
    assert.ok(counts.rides > 0);
    assert.equal(counts.payments, counts.rides);
    assert.equal(counts.credits, counts.rides);
    const [[defaults]] =
      await pool.query(`SELECT COUNT(*) AS count FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
      WHERE c.table_schema=DATABASE() AND LOWER(c.column_default) LIKE '%utc_timestamp(3)%'`);
    assert.equal(defaults.count, 11);
    const connection = await pool.getConnection();
    try {
      await connection.query("SET time_zone='+08:00'");
      await connection.beginTransaction();
      const [[bike]] =
        await connection.query(`SELECT b.id,z.id AS zone_id,z.x,z.y FROM bikes b
        JOIN parking_zones z ON z.id=b.current_zone_id WHERE b.status='AVAILABLE' ORDER BY b.id LIMIT 1`);
      const [started] = await connection.query("CALL sp_start_ride(?,?)", [
        2,
        bike.id,
      ]);
      const orderId = started[0][0].id;
      const [prepared] = await connection.query(
        "CALL sp_prepare_ride_return(?,?,?,?,?,?,?)",
        [2, orderId, bike.zone_id, bike.x, bike.y, null, "MAP_SIMULATION"],
      );
      assert.equal(prepared[0][0].rejected, undefined);
      await connection.query(
        "CALL sp_finish_ride_return(?,?,?,?,?,?,?,?,?,?)",
        [
          2,
          orderId,
          bike.zone_id,
          bike.x,
          bike.y,
          prepared[0][0].captured_at,
          "MAP_SIMULATION",
          "shortest",
          0,
          prepared[0][0].return_time,
        ],
      );
      await connection.query("CALL sp_pay_ride(?,?,?)", [
        2,
        orderId,
        "timezone-probe",
      ]);
      const [[clock]] = await connection.query(
        `SELECT
        ABS(TIMESTAMPDIFF(SECOND,r.started_at,UTC_TIMESTAMP(3))) AS ride_delta,
        ABS(TIMESTAMPDIFF(SECOND,p.paid_at,UTC_TIMESTAMP(3))) AS payment_delta,
        ABS(TIMESTAMPDIFF(SECOND,c.created_at,UTC_TIMESTAMP(3))) AS carbon_delta
        FROM ride_orders r JOIN payments p ON p.order_id=r.id JOIN carbon_transactions c ON c.order_id=r.id AND c.entry_type='AWARD' WHERE r.id=?`,
        [orderId],
      );
      assert.ok(Object.values(clock).every((delta) => delta <= 30));
    } finally {
      await connection.rollback();
      await connection.query("SET time_zone='+00:00'");
      connection.release();
    }
    const now = new Date();
    const boundary = now.getTime() - 7 * 86400000;
    await pool.query(
      "INSERT INTO zone_snapshots(zone_id,available,occupied,capacity,captured_at,source) VALUES(1,0,24,24,?,'DEMO'),(1,1,23,24,?,'DEMO')",
      [new Date(boundary - 180000), new Date(boundary + 120000)],
    );
    const [allZones] = await pool.query(
      "SELECT * FROM v_zone_inventory ORDER BY id",
    );
    const [allRides] = await pool.query("SELECT * FROM ride_orders");
    const [allSnapshots] = await pool.query(
      "SELECT * FROM zone_snapshots ORDER BY captured_at",
    );
    for (const demand of [
      [],
      [{ zone_id: 2, borrow_count: 14, return_count: 1 }],
    ]) {
      assert.deepEqual(
        await dispatchSuggestions(pool, allZones, demand),
        expectedSuggestions(allZones, demand),
      );
    }
    let randomState = 0x12345678;
    const random = (max) => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState % max;
    };
    for (let run = 0; run < 40; run++) {
      const zones = Array.from({ length: 1 + random(10) }, (_, index) => {
        const capacity = 5 + random(50),
          occupied = random(capacity + 1),
          available = random(occupied + 1);
        return {
          id: index + 1,
          name: `站点${index + 1}`,
          capacity,
          occupied,
          available,
          reserved: random(capacity - occupied + 1),
          status: random(5) ? "ACTIVE" : "CLOSED",
        };
      });
      const demand = zones.map((zone) => ({
        zone_id: zone.id,
        borrow_count: random(30),
        return_count: random(30),
      }));
      assert.deepEqual(
        await dispatchSuggestions(pool, zones, demand),
        expectedSuggestions(zones, demand),
      );
    }
    const beijingDay = (date) =>
      new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    for (const filter of [
      7,
      30,
      { days: 7, dayType: "WEEKDAY", startHour: 0, endHour: 12, zoneId: 1 },
      {
        start: beijingDay(new Date(now.getTime() - 4 * 86400000)),
        end: beijingDay(now),
        dayType: "WEEKDAY",
        startHour: 0,
        endHour: 12,
        zoneId: 1,
      },
    ]) {
      const expected = aggregateHotspots(
        allZones,
        allRides,
        allSnapshots,
        filter,
        now,
      );
      const { zones, report: actual } = await hotspotReport(pool, filter, now);
      const quick = await hotspotDemand(pool, filter, now);
      assert.deepEqual(quick.zones, zones);
      assert.deepEqual(quick.filter, actual.filter);
      assert.deepEqual(
        quick.demand,
        actual.hotspots.map(({ zone_id, borrow_count, return_count }) => ({
          zone_id,
          borrow_count,
          return_count,
        })),
      );
      assert.deepEqual(
        await dispatchSuggestions(pool, quick.zones, quick.demand),
        await dispatchSuggestions(pool, zones, actual.hotspots),
      );
      const sortSeries = (rows) =>
        rows.sort(
          (a, b) =>
            a.zone_id - b.zone_id ||
            new Date(a.captured_at) - new Date(b.captured_at),
        );
      assert.deepEqual(
        sortSeries(actual.inventory_series),
        sortSeries(expected.inventory_series),
      );
      delete actual.inventory_series;
      delete expected.inventory_series;
      assert.deepEqual(actual, expected);
    }
    await pool.query(
      "INSERT INTO zone_snapshots(zone_id,available,occupied,capacity,captured_at,source) VALUES(1,0,10,24,'2026-10-04 15:58:00','DEMO'),(1,0,10,24,'2026-10-04 16:02:00','DEMO'),(1,0,10,24,'2026-10-04 23:58:00','DEMO'),(1,0,10,24,'2026-10-05 00:02:00','DEMO'),(1,0,10,24,'2026-10-05 00:59:00','DEMO'),(1,0,10,24,'2026-10-05 01:03:00','DEMO')",
    );
    const fixedNow = new Date("2026-10-06T00:00:00Z");
    const morningFilter = {
      start: "2026-10-05",
      end: "2026-10-05",
      dayType: "WEEKDAY",
      startHour: 8,
      endHour: 9,
      zoneId: 1,
    };
    const morning = (await hotspotReport(pool, morningFilter, fixedNow)).report;
    assert.equal(morning.hotspots[0].coverage_minutes, 3);
    assert.equal(morning.hotspots[0].coverage_ratio, 0.05);
    const midnight = (
      await hotspotReport(
        pool,
        { ...morningFilter, startHour: 0, endHour: 1 },
        fixedNow,
      )
    ).report;
    assert.equal(midnight.hotspots[0].coverage_minutes, 2);
    assert.equal(midnight.hotspots[0].coverage_ratio, 0.03);
    await pool.query(`INSERT INTO zone_snapshots(zone_id,available,occupied,capacity,captured_at,source)
      WITH RECURSIVE digits AS (SELECT 0 AS n UNION ALL SELECT n+1 FROM digits WHERE n<9)
      SELECT 1,CASE WHEN n=777 THEN 0 WHEN n=778 THEN 23 ELSE 10 END,24,24,
        TIMESTAMP('2026-09-01 00:00:00')+INTERVAL n MINUTE,'DEMO'
      FROM (SELECT a.n+b.n*10+c.n*100+d.n*1000 AS n FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d) numbers
      WHERE n<1300`);
    const dense = (
      await hotspotReport(
        pool,
        {
          start: "2026-09-01",
          end: "2026-09-02",
          dayType: "ALL",
          startHour: 0,
          endHour: 24,
          zoneId: 1,
        },
        new Date("2026-09-03T00:00:00Z"),
      )
    ).report;
    assert.equal(dense.snapshot_count, 1300);
    assert.ok(dense.inventory_series.length <= 1200);
    assert.ok(dense.inventory_series.some((sample) => sample.available === 0));
    assert.ok(dense.inventory_series.some((sample) => sample.available === 23));
    assert.equal(dense.hotspots[0].coverage_minutes, 1299);
    assert.deepEqual(
      [...new Set(dense.inventory_series.map((sample) => sample.segment_id))],
      [1],
    );
    assert.ok(
      dense.inventory_series.some(
        (sample, index, series) =>
          index > 0 &&
          sample.captured_at - series[index - 1].captured_at > 300000,
      ),
    );
    await pool.query(`DELETE FROM zone_snapshots WHERE zone_id=1
      AND captured_at>=TIMESTAMP('2026-09-01 00:00:00')+INTERVAL 650 MINUTE
      AND captured_at<TIMESTAMP('2026-09-01 00:00:00')+INTERVAL 660 MINUTE`);
    const withGap = (
      await hotspotReport(
        pool,
        { start: "2026-09-01", end: "2026-09-02", zoneId: 1 },
        new Date("2026-09-03T00:00:00Z"),
      )
    ).report;
    assert.equal(withGap.snapshot_count, 1290);
    assert.equal(withGap.hotspots[0].coverage_minutes, 1288);
    assert.deepEqual(
      [...new Set(withGap.inventory_series.map((sample) => sample.segment_id))],
      [1, 2],
    );
    assert.ok(withGap.inventory_series.length <= 1200);
    const [[user]] = await pool.query(
      "SELECT password_hash FROM users WHERE id=1",
    );
    assert.equal(
      await bcrypt.compare("Qingxing2026!", user.password_hash),
      true,
    );
    assert.equal(await seedDemo(appPool, pool), false);
    assert.equal(await ledgerTransaction(appPool, upgradeCampusMap), false);
    const [[unchanged]] = await pool.query(
      "SELECT COUNT(*) rides FROM ride_orders",
    );
    assert.equal(unchanged.rides, counts.rides);
    await pool.query(`INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,status)
      VALUES(1,1,1,1,'2026-08-04 16:00:00','2026-08-04 16:01:00','UNPAID'),
        (1,1,1,1,'2026-08-05 15:58:00','2026-08-05 16:00:00','UNPAID'),
        (1,1,1,1,'2026-08-05 16:00:00','2026-08-05 16:01:00','UNPAID')`);
    await pool.query(`INSERT INTO zone_snapshots(zone_id,available,occupied,capacity,captured_at,source)
      VALUES(1,0,10,24,'2026-08-04 16:00:00','DEMO'),
        (1,0,10,24,'2026-08-05 15:58:00','DEMO'),
        (1,0,10,24,'2026-08-05 16:00:00','DEMO')`);
    const day = (
      await hotspotReport(
        pool,
        { start: "2026-08-05", end: "2026-08-05", zoneId: 1 },
        new Date("2026-08-06T00:00:00Z"),
      )
    ).report;
    assert.equal(day.hotspots[0].borrow_count, 2);
    assert.equal(day.hotspots[0].return_count, 1);
    assert.equal(day.snapshot_count, 2);
    assert.equal(day.inventory_series.length, 2);
    assert.equal(day.hotspots[0].coverage_minutes, 2);
    assert.equal(day.hotspots[0].shortage_minutes, 2);
    await pool.query(`INSERT INTO zone_snapshots(zone_id,available,occupied,capacity,captured_at,source)
      VALUES(1,0,24,24,'2026-07-05 15:58:00','DEMO'),
        (1,0,24,24,'2026-07-05 16:02:00','DEMO'),
        (2,0,24,24,'2026-07-05 15:57:00','DEMO'),
        (2,0,24,24,'2026-07-05 16:03:00','DEMO')`);
    const boundaryFilter = {
      start: "2026-07-05",
      end: "2026-07-05",
      dayType: "WEEKEND",
      zoneId: 1,
    };
    const observed = (
      await hotspotReport(
        pool,
        boundaryFilter,
        new Date("2026-07-05T16:03:00Z"),
      )
    ).report;
    assert.equal(observed.hotspots[0].coverage_minutes, 2);
    assert.equal(observed.hotspots[0].shortage_minutes, 2);
    assert.equal(observed.hotspots[0].full_minutes, 2);
    assert.equal(observed.snapshot_count, 1);
    assert.equal(observed.inventory_series.length, 1);
    const notYetObserved = (
      await hotspotReport(
        pool,
        boundaryFilter,
        new Date("2026-07-05T16:01:00Z"),
      )
    ).report;
    assert.equal(notYetObserved.hotspots[0].coverage_minutes, 0);
    assert.equal(notYetObserved.snapshot_count, 1);
    const gap = (
      await hotspotReport(
        pool,
        { ...boundaryFilter, zoneId: 2 },
        new Date("2026-07-05T16:04:00Z"),
      )
    ).report;
    assert.equal(gap.hotspots[0].coverage_minutes, 0);
    assert.equal(gap.snapshot_count, 1);
    const empty = (
      await hotspotReport(
        pool,
        { start: "2025-01-01", end: "2025-01-01", zoneId: 1 },
        new Date("2026-07-05T16:04:00Z"),
      )
    ).report;
    assert.equal(empty.snapshot_count, 0);
    assert.equal(empty.hotspots[0].coverage_minutes, 0);
    assert.deepEqual(empty.inventory_series, []);
    await pool.query("DELETE FROM system_settings WHERE name='seed_version'");
    await assert.rejects(seedDemo(appPool, pool), /Nonempty unmarked database/);
    const [[afterFailure]] = await pool.query(
      "SELECT COUNT(*) bikes FROM bikes",
    );
    assert.equal(afterFailure.bikes, 66);
  } finally {
    if (appPool) await appPool.end();
    if (pool) await pool.end();
    if (userCreated) await admin.query(`DROP USER '${username}'@'localhost'`);
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
