import { open, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { runProcess } from "./process.mjs";
import "../backend/db.mjs";
export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export async function runMysqlTool(
  tool,
  args,
  { input, output, run = runProcess } = {},
) {
  const runtime = join(projectRoot, ".runtime");
  await mkdir(runtime, { recursive: true });
  const credentialFile = join(
    runtime,
    `client-${randomBytes(8).toString("hex")}.ini`,
  );
  // MySQL option-file escapes preserve custom credentials and Windows-friendly line endings.
  const escape = (x) =>
    String(x)
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r")
      .replaceAll("\t", "\\t")
      .replaceAll("\b", "\\b");
  const executable = process.platform === "win32" ? `${tool}.exe` : tool;
  const binary = process.env.MYSQL_BASE
    ? join(process.env.MYSQL_BASE, "bin", executable)
    : executable;
  const handle = await open(credentialFile, "wx", 0o600);
  let closed = false,
    failed = false,
    failure;
  try {
    await handle.writeFile(
      `[client]\nhost="${escape(process.env.DB_HOST || "127.0.0.1")}"\nport=${Number(process.env.DB_PORT || 3306)}\nuser="${escape(process.env.DB_ADMIN_USER)}"\npassword="${escape(process.env.DB_ADMIN_PASSWORD)}"\n`,
    );
    await handle.close();
    closed = true;
    await run(binary, [`--defaults-extra-file=${credentialFile}`, ...args], {
      input,
      output,
    });
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    const cleanup = [];
    if (!closed) {
      try {
        await handle.close();
      } catch (error) {
        cleanup.push(error);
      }
    }
    try {
      await unlink(credentialFile);
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length) {
      if (failed)
        throw new AggregateError(
          [failure, ...cleanup],
          "MySQL 客户端执行及临时配置清理均失败",
        );
      if (cleanup.length === 1) throw cleanup[0];
      throw new AggregateError(cleanup, "MySQL 客户端临时配置清理失败");
    }
  }
}
