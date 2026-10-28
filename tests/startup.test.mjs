import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPool } from "../backend/db.mjs";
import { sql } from "../backend/sql-statements.mjs";
import { applySchema } from "../scripts/sql.mjs";

test("application refuses an incompatible or missing database version before listening", async () => {
  const database = `campus_bike_startup_test_${randomBytes(4).toString("hex")}`;
  const credentials = {
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  };
  const admin = createPool({ ...credentials, database: undefined });
  let pool,
    created = false;
  try {
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    pool = createPool({ ...credentials, database });
    await applySchema(pool);
    for (const expression of [
      "JSON_OBJECT('version',11)",
      "JSON_OBJECT('version','11')",
    ]) {
      await pool.query(
        `UPDATE system_settings SET value=${expression} WHERE name='pdf_expansion'`,
      );
      const [[{ compatible }]] = await pool.query(
        sql("schema_version_compatible"),
      );
      assert.equal(compatible, 1);
    }
    const assertStartupRejected = async (description) => {
      const processResult = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("../backend/index.mjs", import.meta.url))],
        {
          env: {
            ...process.env,
            DB_NAME: database,
            DB_USER: credentials.user,
            DB_PASSWORD: credentials.password,
            HOST: "127.0.0.1",
            PORT: "0",
          },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      assert.equal(processResult.status, 1, `${description} 应拒绝启动`);
      assert.match(processResult.stderr, /SCHEMA_VERSION_MISMATCH/);
      assert.doesNotMatch(processResult.stdout, /Qingxing ready/);
      const [[{ snapshots }]] = await pool.query(
        "SELECT COUNT(*) AS snapshots FROM zone_snapshots",
      );
      assert.equal(snapshots, 0);
    };
    for (const expression of [
      "JSON_OBJECT('version',12)",
      "JSON_OBJECT('version',10)",
      "JSON_OBJECT('version',CONCAT('11',CHAR(10)))",
      null,
    ]) {
      if (expression === null)
        await pool.query(
          "DELETE FROM system_settings WHERE name='pdf_expansion'",
        );
      else
        await pool.query(
          `INSERT INTO system_settings(name,value) VALUES('pdf_expansion',${expression}) ON DUPLICATE KEY UPDATE value=VALUES(value)`,
        );
      await assertStartupRejected(`版本标记 ${expression}`);
    }
    await pool.query("DROP TABLE system_settings");
    await assertStartupRejected("缺少配置表");
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
