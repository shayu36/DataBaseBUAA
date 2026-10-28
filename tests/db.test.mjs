import test from "node:test";
import assert from "node:assert/strict";
import {
  ledgerTransaction,
  readSnapshot,
  withNamedLock,
  errorCodes,
} from "../backend/db.mjs";
import { applyFeatureMigrations } from "../backend/feature-migrations.mjs";
import { seedDemo } from "../backend/demo-seed.mjs";

function fixture(releaseResult, options = {}) {
  const events = [];
  const connection = {
    async query(statement) {
      if (statement.includes("GET_LOCK")) {
        if (options.lockError) throw options.lockError;
        return [[{ acquired: options.acquired ?? 1 }]];
      }
      if (statement.includes("REPEATABLE READ")) {
        events.push("isolation");
        return [];
      }
      if (statement.includes("CONSISTENT SNAPSHOT")) {
        events.push("snapshot");
        if (options.snapshotError) throw options.snapshotError;
        return [];
      }
      if (statement.includes("RELEASE_LOCK")) {
        events.push("unlock");
        if (releaseResult instanceof Error) throw releaseResult;
        return [[{ released: releaseResult }]];
      }
      if (options.migration && statement.includes("CREATE PROCEDURE")) {
        events.push("create");
        return [];
      }
      if (options.seedError && statement.startsWith("CALL ??")) {
        events.push("seed");
        throw options.seedError;
      }
      if (options.migration && statement.startsWith("CALL ??")) {
        events.push("migrate");
        if (options.migrationError) throw options.migrationError;
        return [[[{ migrated: 1 }]]];
      }
      if (options.migration && statement.startsWith("DROP PROCEDURE")) {
        events.push("drop");
        if (options.dropError) throw options.dropError;
        return [];
      }
      throw new Error("意外的数据库操作");
    },
    async beginTransaction() {
      events.push("begin");
    },
    async commit() {
      events.push("commit");
    },
    async rollback() {
      events.push("rollback");
      if (options.rollbackError) throw options.rollbackError;
    },
    release() {
      events.push("release");
    },
    destroy() {
      events.push("destroy");
    },
  };
  return {
    connection,
    pool: {
      async getConnection() {
        return connection;
      },
    },
    events,
  };
}

test("a successful transaction unlocks before returning the connection", async () => {
  const { pool, events } = fixture(1);
  assert.equal(await ledgerTransaction(pool, async () => 42), 42);
  assert.deepEqual(events, ["begin", "commit", "unlock", "release"]);
});

test("migration discards connections when lock acquisition is uncertain", async () => {
  for (const pooled of [true, false]) {
    const failure = new Error("迁移锁响应中断");
    const { pool, connection, events } = fixture(1, { lockError: failure });
    await assert.rejects(
      applyFeatureMigrations(pooled ? pool : connection),
      (error) => error === failure,
    );
    assert.deepEqual(events, ["destroy"]);
  }
});

test("migration returns a pooled connection when its lock is busy", async () => {
  const { pool, events } = fixture(1, { acquired: 0 });
  await assert.rejects(applyFeatureMigrations(pool), { code: "BUSY" });
  assert.deepEqual(events, ["release"]);
});

test("migration drops its temporary procedure and releases a confirmed lock", async () => {
  const { pool, events } = fixture(1, { migration: true });
  assert.deepEqual(await applyFeatureMigrations(pool), {
    applied: ["pdf_expansion@15"],
  });
  assert.deepEqual(events, [
    "create",
    "migrate",
    "drop",
    "unlock",
    "unlock",
    "release",
  ]);
});

test("DDL failure releases its lock without pretending to roll back", async () => {
  const failure = new Error("结构更新失败");
  const { pool, events } = fixture(1);
  await assert.rejects(
    withNamedLock(pool, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, ["unlock", "release"]);
});

test("uncertain lock acquisition discards the connection", async () => {
  const failure = new Error("锁查询中断");
  const { pool, events } = fixture(1, { lockError: failure });
  await assert.rejects(
    ledgerTransaction(pool, async () => {}),
    (error) => error === failure,
  );
  assert.deepEqual(events, ["destroy"]);
});

test("a busy lock returns the connection without starting a transaction", async () => {
  const { pool, events } = fixture(1, { acquired: 0 });
  await assert.rejects(
    ledgerTransaction(pool, async () => {}),
    { code: "BUSY" },
  );
  assert.deepEqual(events, ["release"]);
});

test("successful rollback unlocks before returning the connection", async () => {
  const original = new Error("写入失败");
  const { pool, events } = fixture(1);
  await assert.rejects(
    ledgerTransaction(pool, async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert.deepEqual(events, ["begin", "rollback", "unlock", "release"]);
});

test("transaction rollback failure destroys the connection and preserves both errors", async () => {
  const original = new Error("写入失败"),
    rollbackError = new Error("回滚中断");
  const { pool, events } = fixture(1, { rollbackError });
  await assert.rejects(
    ledgerTransaction(pool, async () => {
      throw original;
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === original &&
      error.errors[1] === rollbackError,
  );
  assert.deepEqual(events, ["begin", "rollback", "destroy"]);
});

test("failed read snapshot setup or rollback cannot return a dirty connection", async () => {
  const setupError = new Error("快照启动失败");
  const setup = fixture(1, { snapshotError: setupError });
  await assert.rejects(
    readSnapshot(setup.pool, async () => {}),
    (error) => error === setupError,
  );
  assert.deepEqual(setup.events, ["isolation", "snapshot", "destroy"]);

  const original = new Error("查询失败"),
    rollbackError = new Error("回滚中断");
  const failed = fixture(1, { rollbackError });
  await assert.rejects(
    readSnapshot(failed.pool, async () => {
      throw original;
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === original &&
      error.errors[1] === rollbackError,
  );
  assert.deepEqual(failed.events, [
    "isolation",
    "snapshot",
    "rollback",
    "destroy",
  ]);
});

test("a connection with an unconfirmed lock release is destroyed", async () => {
  for (const outcome of [0, null, new Error("连接中断")]) {
    const { pool, events } = fixture(outcome);
    await assert.rejects(ledgerTransaction(pool, async () => 42));
    assert.deepEqual(events, ["begin", "commit", "unlock", "destroy"]);
  }
});

test("work and lock release failures are both preserved and the connection is discarded", async () => {
  const original = Object.assign(new Error("隐私数据"), {
    code: "WRITE_FAILED",
  });
  const unlockError = Object.assign(new Error("锁释放失败"), {
    code: "UNLOCK_FAILED",
  });
  assert.deepEqual(
    errorCodes(
      new AggregateError([new AggregateError([original]), unlockError]),
    ),
    ["WRITE_FAILED", "UNLOCK_FAILED"],
  );
  const { pool, events } = fixture(unlockError);
  await assert.rejects(
    ledgerTransaction(pool, async () => {
      throw original;
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === original &&
      error.errors[1] === unlockError,
  );
  assert.deepEqual(events, ["begin", "rollback", "unlock", "destroy"]);
});

test("migration and temporary procedure cleanup failures are both preserved", async () => {
  const migrationError = new Error("迁移执行失败");
  const dropError = new Error("临时过程清理失败");
  const { pool, events } = fixture(1, {
    migration: true,
    migrationError,
    dropError,
  });
  await assert.rejects(
    applyFeatureMigrations(pool),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === migrationError &&
      error.errors[1] === dropError,
  );
  assert.deepEqual(events, [
    "create",
    "migrate",
    "drop",
    "unlock",
    "unlock",
    "release",
  ]);
});

test("seed and temporary procedure cleanup failures are both preserved", async () => {
  const seedError = new Error("演示数据写入失败");
  const dropError = new Error("演示过程清理失败");
  const { pool, events } = fixture(1, { seedError });
  const adminEvents = [];
  const adminPool = {
    async getConnection() {
      return {
        async query(sql) {
          if (sql.includes("GET_LOCK")) {
            adminEvents.push("lock");
            return [[{ acquired: 1 }]];
          }
          if (sql.includes("RELEASE_LOCK")) {
            adminEvents.push("unlock");
            return [[{ released: 1 }]];
          }
          if (sql.includes("CREATE PROCEDURE")) {
            adminEvents.push("create");
            return [];
          }
          if (sql.startsWith("DROP PROCEDURE")) {
            adminEvents.push("drop");
            throw dropError;
          }
          throw new Error("意外的数据库操作");
        },
        release() {
          adminEvents.push("release");
        },
      };
    },
  };
  await assert.rejects(
    seedDemo(pool, adminPool),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === seedError &&
      error.errors[1] === dropError,
  );
  assert.deepEqual(events, ["begin", "seed", "rollback", "unlock", "release"]);
  assert.deepEqual(adminEvents, [
    "lock",
    "create",
    "drop",
    "unlock",
    "release",
  ]);
});

test("seed retains the schema lock while cleaning up after a broken transaction", async () => {
  const seedError = new Error("演示数据写入失败");
  const rollbackError = new Error("回滚失败");
  const { pool, events } = fixture(1, { seedError, rollbackError });
  let locked = false,
    dropped = false;
  const adminPool = {
    async getConnection() {
      return {
        async query(statement) {
          if (statement.includes("GET_LOCK")) {
            locked = true;
            return [[{ acquired: 1 }]];
          }
          if (statement.includes("RELEASE_LOCK")) {
            locked = false;
            return [[{ released: 1 }]];
          }
          if (statement.includes("CREATE PROCEDURE")) {
            assert.equal(locked, true);
            return [];
          }
          if (statement.startsWith("DROP PROCEDURE")) {
            assert.equal(locked, true);
            assert.deepEqual(events, ["begin", "seed", "rollback", "destroy"]);
            dropped = true;
            return [];
          }
          throw new Error("意外的数据库操作");
        },
        release() {},
        destroy() {
          throw new Error("不应销毁正常的管理连接");
        },
      };
    },
  };
  await assert.rejects(
    seedDemo(pool, adminPool),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === seedError &&
      error.errors[1] === rollbackError,
  );
  assert.equal(dropped, true);
  assert.equal(locked, false);
});
