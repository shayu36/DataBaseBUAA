import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "./sql-statements.mjs";
import { withNamedLock } from "./db.mjs";

// DDL and migration decisions live in MySQL. Use a unique temporary routine so
// concurrent invocations do not overwrite another session's migration routine.
export function applyFeatureMigrations(db) {
  return withNamedLock(db, applyFeatureMigrationsLocked);
}

// Caller holds the database named lock throughout the surrounding DDL.
export async function applyFeatureMigrationsLocked(connection) {
  const name = `qingxing_migration_${randomBytes(8).toString("hex")}`;
  const migrationSql = await readFile(
    new URL("../database/feature-migration.sql", import.meta.url),
    "utf8",
  );
  let created = false;
  try {
    await connection.query(
      migrationSql.replace("__MIGRATION_PROCEDURE__", `\`${name}\``),
    );
    created = true;
    const [result] = await connection.query(sql("call_temporary_procedure"), [
      name,
    ]);
    return { applied: result[0][0].migrated ? ["pdf_expansion@11"] : [] };
  } finally {
    if (created)
      await connection.query(sql("drop_temporary_procedure"), [name]);
  }
}
