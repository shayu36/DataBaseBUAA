import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { exportRides } from "../backend/history.mjs";

test("an interrupted CSV export destroys the connection instead of reusing it", async () => {
  const failure = new Error("客户端连接中断");
  const events = [];
  const connection = {
    connection: { query: () => ({ stream: () => Readable.from([{ id: 1 }]) }) },
    release: () => events.push("release"),
    destroy: () => events.push("destroy"),
  };
  const response = new Writable({
    write(_chunk, _encoding, callback) {
      callback(failure);
    },
  });
  response.attachment = () => response;
  response.set = () => response;
  await assert.rejects(
    exportRides(
      { getConnection: async () => connection },
      { id: 2 },
      "ALL",
      response,
    ),
    (error) => error === failure,
  );
  assert.deepEqual(events, ["destroy"]);
});
