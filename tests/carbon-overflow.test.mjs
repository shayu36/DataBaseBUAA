import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPool } from "../backend/db.mjs";
import { applyProcedures, applySchema } from "../scripts/sql.mjs";

test("native carbon precision and limits hold with non-strict SQL mode", async () => {
  const name = `campus_bike_carbon_test_${randomBytes(4).toString("hex")}`;
  const credentials = {
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  };
  const admin = createPool({ ...credentials, database: undefined });
  let pool,
    connection,
    created = false;
  try {
    await admin.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    pool = createPool({ ...credentials, database: name });
    await applySchema(pool);
    connection = await pool.getConnection();
    await connection.query("SET SESSION sql_mode=''");
    await applyProcedures(connection);
    const [[routine]] = await connection.query(
      "SELECT sql_mode AS routine_mode FROM information_schema.routines WHERE routine_schema=DATABASE() AND routine_name='sp_award_carbon'",
    );
    assert.equal(routine.routine_mode, "");
    await connection.query(
      "INSERT INTO users(id,name,email,phone,password_hash) VALUES(1,'学生','native@example.test','13000000000','hash')",
    );
    await connection.query(
      "INSERT INTO parking_zones(id,name,location,x,y,capacity) VALUES(1,'起点','北',100,100,10),(2,'终点','南',200,100,10)",
    );
    await connection.query(
      "INSERT INTO bikes(id,code,deployed_at,current_zone_id) VALUES(1,'TEST','2026-01-01',1)",
    );
    await connection.query(
      "INSERT INTO ride_orders(id,user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,distance_m,amount_cents,status) VALUES(1,1,1,1,2,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),1000,100,'UNPAID')",
    );
    for (const [factor, rate] of [
      ["0.21", "2147483648"],
      ["99999999.99995", "10"],
    ]) {
      await connection.query(
        "INSERT INTO system_settings(name,value) VALUES('carbon',JSON_OBJECT('kg_per_km',?,'points_per_km',?)) ON DUPLICATE KEY UPDATE value=VALUES(value)",
        [factor, rate],
      );
      await connection.beginTransaction();
      try {
        await assert.rejects(
          connection.query("CALL sp_pay_ride(1,1,'non-strict-overflow')"),
          {
            code: "ER_SIGNAL_EXCEPTION",
            sqlMessage: "CARBON_AWARD_OUT_OF_RANGE",
          },
        );
      } finally {
        await connection.rollback();
      }
      const [[state]] = await connection.query(
        "SELECT status,(SELECT COUNT(*) FROM payments) payments,(SELECT COUNT(*) FROM carbon_transactions) entries FROM ride_orders WHERE id=1",
      );
      assert.deepEqual(state, { status: "UNPAID", payments: 0, entries: 0 });
    }
    await connection.query("SET SESSION div_precision_increment=0");
    await connection.query("UPDATE ride_orders SET distance_m=1 WHERE id=1");
    await connection.query(
      "UPDATE system_settings SET value=JSON_OBJECT('kg_per_km','0.04999999','points_per_km',0) WHERE name='carbon'",
    );
    await connection.beginTransaction();
    try {
      await connection.query("CALL sp_pay_ride(1,1,'precision-boundary')");
      const [[award]] = await connection.query(
        "SELECT CAST(carbon_kg_change AS CHAR) carbon FROM carbon_transactions WHERE order_id=1",
      );
      assert.equal(award.carbon, "0.0000");
    } finally {
      await connection.rollback();
    }
    await connection.query("CALL sp_pay_ride(1,1,'precision-payment')");
    for (const value of [
      "0.00001",
      "-0.00001",
      "1e100",
      "1e-100",
      "0.00010000000000000000000000000000001",
    ]) {
      await assert.rejects(
        connection.query(
          "CALL sp_adjust_carbon(1,1,1,?,'精度校验','native-adjustment',JSON_OBJECT())",
          [value],
        ),
        { sqlMessage: "INVALID_ADJUSTMENT_AMOUNT" },
      );
    }
    const [[{ adjustments }]] = await connection.query(
      "SELECT COUNT(*) AS adjustments FROM carbon_transactions WHERE entry_type='ADJUSTMENT'",
    );
    assert.equal(adjustments, 0);
  } finally {
    if (connection) connection.release();
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${name}\``);
    await admin.end();
  }
});
