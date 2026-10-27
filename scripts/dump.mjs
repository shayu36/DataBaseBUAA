import { randomBytes } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { runMysqlTool } from "./mysql-tools.mjs";

export async function writeMysqlDump(target, database, run = runMysqlTool) {
  if (typeof database !== "string" || !database || database.startsWith("-"))
    throw new Error("请指定有效的数据库名称");
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
