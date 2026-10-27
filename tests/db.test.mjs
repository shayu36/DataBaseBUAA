import test from "node:test";
import assert from "node:assert/strict";
import { ledgerTransaction } from "../backend/db.mjs";

function fixture(releaseResult) {
  const events = [];
  const connection = {
    async query(statement) {
      if (statement.includes("GET_LOCK")) return [[{ acquired: 1 }]];
      if (statement.includes("RELEASE_LOCK")) {
        events.push("unlock");
        if (releaseResult instanceof Error) throw releaseResult;
        return [[{ released: releaseResult }]];
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
    },
    release() {
      events.push("release");
    },
    destroy() {
      events.push("destroy");
    },
  };
  return {
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

test("a connection with an unconfirmed lock release is destroyed", async () => {
  for (const outcome of [0, null, new Error("连接中断")]) {
    const { pool, events } = fixture(outcome);
    await assert.rejects(ledgerTransaction(pool, async () => 42));
    assert.deepEqual(events, ["begin", "commit", "unlock", "destroy"]);
  }
});
