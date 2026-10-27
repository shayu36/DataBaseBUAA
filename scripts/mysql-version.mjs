import { sql } from "../backend/sql-statements.mjs";

export function supportsMysqlVersion(version) {
  if (/mariadb/i.test(version)) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major > 8 || (major === 8 && (minor > 0 || patch >= 21));
}

export async function assertMysqlVersion(connection) {
  const [[{ version }]] = await connection.query(sql("server_version"));
  if (!supportsMysqlVersion(version)) {
    throw new Error(
      `需要 MySQL 8.0.21 或更高版本；当前数据库版本为 ${version}。`,
    );
  }
}
