import { test } from "node:test";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMysqlDump, writeLockedMysqlDump } from "../scripts/dump.mjs";
import { createPool, ledgerTransaction } from "../backend/db.mjs";

test("failed database export preserves an existing snapshot and removes partial files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qingxing-dump-"));
  try {
    const target = join(directory, "snapshot.sql");
    await writeFile(target, "原有快照");
    const failure = new Error("模拟导出失败");
    await assert.rejects(
      writeMysqlDump(target, "campus_bike", async (_tool, args) => {
        const temporary = args
          .find((arg) => arg.startsWith("--result-file="))
          .slice("--result-file=".length);
        await writeFile(temporary, "部分数据");
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(await readFile(target, "utf8"), "原有快照");
    assert.deepEqual(await readdir(directory), ["snapshot.sql"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful database export replaces the target after completing the dump", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qingxing-dump-"));
  try {
    const target = join(directory, "snapshot.sql");
    await writeFile(target, "旧内容");
    const size = await writeMysqlDump(
      target,
      "campus_bike",
      async (tool, args) => {
        assert.equal(tool, "mysqldump");
        assert.equal(args.at(-1), "campus_bike");
        const temporary = args
          .find((arg) => arg.startsWith("--result-file="))
          .slice("--result-file=".length);
        assert.equal(await readFile(target, "utf8"), "旧内容");
        await writeFile(temporary, "完整导出");
      },
    );
    assert.equal(await readFile(target, "utf8"), "完整导出");
    assert.equal(size, Buffer.byteLength("完整导出"));
    assert.deepEqual(await readdir(directory), ["snapshot.sql"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("empty database export is rejected without replacing an existing snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qingxing-dump-"));
  try {
    const target = join(directory, "snapshot.sql");
    await writeFile(target, "旧内容");
    await assert.rejects(
      writeMysqlDump(target, "campus_bike", async () => {}),
      /导出文件为空/,
    );
    assert.equal(await readFile(target, "utf8"), "旧内容");
    assert.deepEqual(await readdir(directory), ["snapshot.sql"]);
    await assert.rejects(
      writeMysqlDump(target, "--all-databases", async () => {}),
      /数据库名称/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("database export holds the schema lock while business writes continue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qingxing-locked-dump-"));
  const pool = createPool({
    database: "campus_bike_test",
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  });
  const observer = await pool.getConnection();
  const table = `backup_lock_test_${randomBytes(4).toString("hex")}`;
  let created = false,
    writes = 0;
  try {
    await observer.query(
      `CREATE TABLE \`${table}\` (id INT PRIMARY KEY) ENGINE=InnoDB`,
    );
    created = true;
    const target = join(directory, "snapshot.sql");
    const checkLock = async (_tool, args) => {
      const [[{ available }]] = await observer.query(
        "SELECT IS_FREE_LOCK(CONCAT('campus-bike:schema:',DATABASE())) AS available",
      );
      assert.equal(available, 0);
      const [[schemaAttempt]] = await observer.query(
        "SELECT GET_LOCK(CONCAT('campus-bike:schema:',DATABASE()),0) AS acquired",
      );
      assert.equal(schemaAttempt.acquired, 0);
      await ledgerTransaction(pool, (connection) =>
        connection.query(`INSERT INTO \`${table}\` (id) VALUES (?)`, [
          ++writes,
        ]),
      );
      const temporary = args
        .find((arg) => arg.startsWith("--result-file="))
        .slice("--result-file=".length);
      await writeFile(temporary, "完整导出");
    };
    await writeLockedMysqlDump(pool, target, "campus_bike_test", checkLock);
    assert.equal(await readFile(target, "utf8"), "完整导出");
    const [[after]] = await observer.query(
      "SELECT IS_FREE_LOCK(CONCAT('campus-bike:schema:',DATABASE())) AS available",
    );
    assert.equal(after.available, 1);
    await assert.rejects(
      writeLockedMysqlDump(
        pool,
        target,
        "campus_bike_test",
        async (...args) => {
          await checkLock(...args);
          throw new Error("模拟导出失败");
        },
      ),
      /模拟导出失败/,
    );
    assert.equal(await readFile(target, "utf8"), "完整导出");
    const [[afterError]] = await observer.query(
      "SELECT IS_FREE_LOCK(CONCAT('campus-bike:schema:',DATABASE())) AS available",
    );
    assert.equal(afterError.available, 1);
    const [[{ count }]] = await observer.query(
      `SELECT COUNT(*) AS count FROM \`${table}\``,
    );
    assert.equal(count, 2);
    await assert.rejects(
      writeLockedMysqlDump(pool, target, "other_database", checkLock),
      /备份连接与目标数据库不一致/,
    );
  } finally {
    if (created) await observer.query(`DROP TABLE \`${table}\``);
    observer.release();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unconfirmed backup lock release preserves the previous snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qingxing-dump-unlock-"));
  const target = join(directory, "snapshot.sql");
  const releaseError = new Error("模拟锁释放失败");
  let destroyed = false;
  const connection = {
    async query(statement) {
      if (statement.includes("GET_LOCK")) return [[{ acquired: 1 }]];
      if (statement.includes("DATABASE() AS name"))
        return [[{ name: "campus_bike_test" }]];
      if (statement.includes("RELEASE_LOCK")) throw releaseError;
      throw new Error("意外的数据库操作");
    },
    destroy() {
      destroyed = true;
    },
    release() {
      throw new Error("异常连接不应返回连接池");
    },
  };
  try {
    await writeFile(target, "原有快照");
    await assert.rejects(
      writeLockedMysqlDump(
        {
          async getConnection() {
            return connection;
          },
        },
        target,
        "campus_bike_test",
        async (_tool, args) => {
          const temporary = args
            .find((arg) => arg.startsWith("--result-file="))
            .slice("--result-file=".length);
          await writeFile(temporary, "新快照");
        },
      ),
      (error) => error === releaseError,
    );
    assert.equal(destroyed, true);
    assert.equal(await readFile(target, "utf8"), "原有快照");
    assert.deepEqual(await readdir(directory), ["snapshot.sql"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
