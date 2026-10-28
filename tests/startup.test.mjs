import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPool } from "../backend/db.mjs";
import { sessionSecret } from "../backend/config.mjs";
import { sql } from "../backend/sql-statements.mjs";
import {
  loadProcedureSources,
  procedureRevision,
} from "../backend/procedure-revision.mjs";
import { applyProcedures, applySchema } from "../scripts/sql.mjs";

test("procedure revision is stable across Linux and Windows line endings", () => {
  const linux = [{ name: "sample.sql", text: "SELECT 1;\nSELECT 2;\n" }];
  const windows = [{ name: "sample.sql", text: "SELECT 1;\r\nSELECT 2;\r\n" }];
  assert.equal(procedureRevision(linux), procedureRevision(windows));
  assert.notEqual(
    procedureRevision(linux),
    procedureRevision([{ name: "sample.sql", text: "SELECT 3;\n" }]),
  );
});

test("application rejects invalid session secrets before connecting or listening", () => {
  for (const secret of [
    "",
    "short",
    " ".repeat(40),
    "replace-with-at-least-32-random-characters",
  ]) {
    const processResult = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../backend/index.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          JWT_SECRET: secret,
          DB_PORT: "1",
          HOST: "127.0.0.1",
          PORT: "0",
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(processResult.status, 1);
    assert.match(processResult.stderr, /JWT_SECRET/);
    assert.doesNotMatch(processResult.stderr, /ECONNREFUSED/);
    assert.doesNotMatch(processResult.stdout, /Qingxing ready/);
  }
});

test("session secret validation accepts the documented length boundary", () => {
  const previous = process.env.JWT_SECRET;
  try {
    process.env.JWT_SECRET = "a".repeat(32);
    assert.equal(sessionSecret(), "a".repeat(32));
    process.env.JWT_SECRET = `  replace-with-${"x".repeat(32)}`;
    assert.throws(sessionSecret, /JWT_SECRET/);
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});

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
    const revision = procedureRevision(await loadProcedureSources());
    for (const expression of [
      "JSON_OBJECT('version',11)",
      "JSON_OBJECT('version','11')",
    ]) {
      await pool.query(
        `UPDATE system_settings SET value=${expression} WHERE name='pdf_expansion'`,
      );
      const [[{ compatible }]] = await pool.query(
        sql("schema_version_compatible"),
        [revision],
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
    await pool.query(
      "INSERT INTO system_settings(name,value) VALUES('pdf_expansion',JSON_OBJECT('version',11)) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    );
    await pool.query(
      "UPDATE system_settings SET value=JSON_OBJECT('sha256',REPEAT('0',64)) WHERE name='procedure_revision'",
    );
    await assertStartupRejected("过程摘要不匹配");
    await pool.query(
      "DELETE FROM system_settings WHERE name='procedure_revision'",
    );
    await assertStartupRejected("缺少过程摘要");
    await applySchema(pool);
    const failingPool = {
      async getConnection() {
        const connection = await pool.getConnection();
        return new Proxy(connection, {
          get(target, property) {
            if (property === "query")
              return async (statement, ...args) => {
                if (statement.startsWith("CREATE TABLE IF NOT EXISTS users"))
                  throw new Error("模拟结构安装失败");
                return target.query(statement, ...args);
              };
            const value = target[property];
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    await assert.rejects(applySchema(failingPool), /模拟结构安装失败/);
    await assertStartupRejected("结构安装中途失败");
    await applySchema(pool);
    const connection = await pool.getConnection();
    try {
      const failing = new Proxy(connection, {
        get(target, property) {
          if (property === "query")
            return async (statement, ...args) => {
              if (statement.startsWith("CREATE PROCEDURE sp_dashboard"))
                throw new Error("模拟过程安装失败");
              return target.query(statement, ...args);
            };
          const value = target[property];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await assert.rejects(applyProcedures(failing), /模拟过程安装失败/);
    } finally {
      connection.release();
    }
    await assertStartupRejected("过程安装中途失败");
    await applySchema(pool);
    const [[{ compatible }]] = await pool.query(
      sql("schema_version_compatible"),
      [revision],
    );
    assert.equal(compatible, 1);
    await pool.query("DROP TABLE system_settings");
    await assertStartupRejected("缺少配置表");
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
