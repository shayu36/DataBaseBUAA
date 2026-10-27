import test from "node:test";
import assert from "node:assert/strict";
import { ledgerTransaction, readSnapshot } from "../backend/db.mjs";
import { applyFeatureMigrations } from "../backend/feature-migrations.mjs";

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
      if (options.migration && statement.startsWith("CALL ??")) {
        events.push("migrate");
        return [[[{ migrated: 1 }]]];
      }
      if (options.migration && statement.startsWith("DROP PROCEDURE")) {
        events.push("drop");
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
  await assert.rejects(
    applyFeatureMigrations(pool),
    /Could not acquire migration lock/,
  );
  assert.deepEqual(events, ["release"]);
});

test("migration drops its temporary procedure and releases a confirmed lock", async () => {
  const { pool, events } = fixture(1, { migration: true });
  assert.deepEqual(await applyFeatureMigrations(pool), {
    applied: ["pdf_expansion@10"],
  });
  assert.deepEqual(events, ["create", "migrate", "drop", "unlock", "release"]);
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
