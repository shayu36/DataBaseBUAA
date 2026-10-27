import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { runProcess } from "../scripts/process.mjs";

test("process runner reports input failures and stops the child", async () => {
  const failure = new Error("读取失败");
  const input = new Readable({
    read() {
      this.destroy(failure);
    },
  });
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.stdin.resume()"], { input }),
    (error) => error === failure,
  );
});

test("process runner reports output failures and stops the child", async () => {
  const failure = new Error("写入失败");
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(failure);
    },
  });
  await assert.rejects(
    runProcess(
      process.execPath,
      ["-e", "process.stdout.write('data'); setInterval(() => {}, 1000)"],
      { output },
    ),
    (error) => error === failure,
  );
});

test("process runner waits for complete input and flushed output", async () => {
  let text = "",
    flushed = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      setTimeout(callback, 10);
    },
    final(callback) {
      setTimeout(() => {
        flushed = true;
        callback();
      }, 10);
    },
  });
  await runProcess(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    { input: Readable.from(["一", "二"]), output },
  );
  assert.equal(text, "一二");
  assert.equal(flushed, true);
});

test("process runner preserves nonzero exit and stderr", async () => {
  await assert.rejects(
    runProcess(process.execPath, [
      "-e",
      "console.error('模拟错误'); process.exit(7)",
    ]),
    /exited 7:.*模拟错误/s,
  );
});
