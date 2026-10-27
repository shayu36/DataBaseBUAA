import { randomBytes } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { runMysqlTool } from "./mysql-tools.mjs";
import { withNamedLock } from "../backend/db.mjs";
import { sql } from "../backend/sql-statements.mjs";

function validateDatabase(database) {
  if (typeof database !== "string" || !database || database.startsWith("-"))
    throw new Error("请指定有效的数据库名称");
}

export async function writeMysqlDump(target, database, run = runMysqlTool) {
  validateDatabase(database);
  const temporary = join(
    dirname(target),
    `.${basename(target)}-${randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  await handle.close();
  try {
    await run("mysqldump", [
      "--single-transaction",
      "--routines",
      "--triggers",
      "--set-gtid-purged=OFF",
      "--no-tablespaces",
      `--result-file=${temporary}`,
      database,
    ]);
    const { size } = await stat(temporary);
    if (size === 0) throw new Error("数据库导出文件为空");
    await rename(temporary, target);
    return size;
  } finally {
    await rm(temporary, { force: true });
  }
}

// The shared lock prevents project writes and schema changes during the dump.
export async function writeLockedMysqlDump(
  pool,
  target,
  database,
  run = runMysqlTool,
) {
  validateDatabase(database);
  const staged = join(
    dirname(target),
    `.${basename(target)}-${randomBytes(8).toString("hex")}.stage`,
  );
  try {
    const size = await withNamedLock(pool, async (connection) => {
      const [[{ name }]] = await connection.query(sql("current_database"));
      if (name !== database) throw new Error("备份连接与目标数据库不一致");
      return writeMysqlDump(staged, database, run);
    });
    await rename(staged, target);
    return size;
  } finally {
    await rm(staged, { force: true });
  }
}
