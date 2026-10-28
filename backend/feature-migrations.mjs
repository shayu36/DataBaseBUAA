import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "./sql-statements.mjs";
import { withNamedLock, withSchemaLock } from "./db.mjs";

// DDL and migration decisions live in MySQL. Use a unique temporary routine so
// concurrent invocations do not overwrite another session's migration routine.
export function applyFeatureMigrations(db) {
  return withSchemaLock(db, (connection) =>
    withNamedLock(connection, (locked) => applyFeatureMigrationsLocked(locked)),
  );
}

// Caller holds both schema and business locks throughout the surrounding DDL.
export async function applyFeatureMigrationsLocked(
  connection,
  preparing = false,
) {
  const name = `qingxing_migration_${randomBytes(8).toString("hex")}`;
  const migrationSql = await readFile(
    new URL("../database/feature-migration.sql", import.meta.url),
    "utf8",
  );
  let created = false,
    failed = false,
    failure;
  try {
    await connection.query(
      migrationSql.replace("__MIGRATION_PROCEDURE__", `\`${name}\``),
    );
    created = true;
    const [result] = await connection.query(sql("call_temporary_procedure"), [
      name,
      preparing,
    ]);
    return { applied: result[0][0].migrated ? ["pdf_expansion@14"] : [] };
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    if (created) {
      try {
        await connection.query(sql("drop_temporary_procedure"), [name]);
      } catch (cleanupError) {
        if (failed)
          throw new AggregateError(
            [failure, cleanupError],
            "数据库迁移及临时过程清理均失败",
          );
        throw cleanupError;
      }
    }
  }
}
