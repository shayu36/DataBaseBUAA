import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { access, readFile, stat, unlink } from "node:fs/promises";
import { runProcess } from "../scripts/process.mjs";
import { runMysqlTool } from "../scripts/mysql-tools.mjs";

test("MySQL client options use connection defaults and safely quote special characters", async () => {
  const names = [
    "DB_HOST",
    "DB_PORT",
    "DB_ADMIN_USER",
    "DB_ADMIN_PASSWORD",
    "MYSQL_BASE",
  ];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  let temporary;
  try {
    delete process.env.DB_HOST;
    delete process.env.DB_PORT;
    delete process.env.MYSQL_BASE;
    process.env.DB_ADMIN_USER = ' user#"\\name ';
    process.env.DB_ADMIN_PASSWORD = ' p#"\\word\r\n\t\b ';
    await runMysqlTool("mysql", ["--version"], {
      run: async (_binary, args) => {
        temporary = args[0].slice("--defaults-extra-file=".length);
        const contents = await readFile(temporary, "utf8");
        assert.match(contents, /^host="127\.0\.0\.1"$/m);
        assert.match(contents, /^port=3306$/m);
        assert.ok(contents.includes(String.raw`user=" user#\"\\name "`));
        assert.ok(
          contents.includes(String.raw`password=" p#\"\\word\r\n\t\b "`),
        );
        if (process.platform !== "win32")
          assert.equal((await stat(temporary)).mode & 0o777, 0o600);
      },
    });
    await assert.rejects(access(temporary), { code: "ENOENT" });
  } finally {
    for (const name of names)
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
  }
});

test("MySQL client removes its temporary options file after process failure", async () => {
  const failure = new Error("模拟客户端失败");
  let temporary;
  await assert.rejects(
    runMysqlTool("mysql", [], {
      run: async (_binary, args) => {
        temporary = args[0].slice("--defaults-extra-file=".length);
        await access(temporary);
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  await assert.rejects(access(temporary), { code: "ENOENT" });
});

test("MySQL client preserves both process and cleanup failures", async () => {
  const failure = new Error("模拟客户端失败");
  await assert.rejects(
    runMysqlTool("mysql", [], {
      run: async (_binary, args) => {
        const file = args[0].slice("--defaults-extra-file=".length);
        await unlink(file);
        throw failure;
      },
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === failure &&
      error.errors[1]?.code === "ENOENT",
  );
});

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
