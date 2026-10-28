import test from "node:test";
import assert from "node:assert/strict";
import { initializeAccount } from "../scripts/bootstrap-account.mjs";
import { sql } from "../backend/sql-statements.mjs";

const options = {
  host: "127.0.0.1",
  port: 3306,
  user: "qingxing_app",
  password: "test-password",
};

test("bootstrap verifies account credentials before granting privileges", async () => {
  const statements = [];
  const admin = { query: async (statement) => statements.push(statement) };
  const failure = new Error("模拟账号密码错误");
  await assert.rejects(
    initializeAccount(admin, options, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(statements, [sql("create_application_user")]);
});

test("bootstrap rejects another matched MySQL account before granting", async () => {
  const events = [];
  const admin = { query: async (statement) => events.push(statement) };
  await assert.rejects(
    initializeAccount(admin, options, async () => ({
      query: async () => [[{ account: "other@localhost" }]],
      end: async () => events.push("closed"),
    })),
    /未匹配预期/,
  );
  assert.deepEqual(events, [sql("create_application_user"), "closed"]);
});

test("bootstrap grants privileges only after verifying the intended account", async () => {
  const events = [];
  const admin = { query: async (statement) => events.push(statement) };
  await initializeAccount(admin, options, async (received) => {
    assert.deepEqual(received, options);
    return {
      query: async (statement) => {
        assert.equal(statement, sql("current_account"));
        events.push("verified");
        return [[{ account: "qingxing_app@localhost" }]];
      },
      end: async () => events.push("closed"),
    };
  });
  assert.deepEqual(events, [
    sql("create_application_user"),
    "verified",
    "closed",
    sql("grant_application_user"),
  ]);
});
