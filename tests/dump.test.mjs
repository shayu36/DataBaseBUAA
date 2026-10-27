import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMysqlDump } from "../scripts/dump.mjs";

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
