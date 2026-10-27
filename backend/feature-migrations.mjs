import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "./sql-statements.mjs";
import { releaseNamedLock } from "./db.mjs";

// DDL and migration decisions live in MySQL. Use a unique temporary routine so
// concurrent invocations do not overwrite another session's migration routine.
export async function applyFeatureMigrations(db) {
  const name = `qingxing_migration_${randomBytes(8).toString("hex")}`;
  const migrationSql = await readFile(
    new URL("../database/feature-migration.sql", import.meta.url),
    "utf8",
  );
  const connection =
    typeof db.getConnection === "function" ? await db.getConnection() : db;
  let created = false;
  let locked = false;
  let lockUncertain = true;
  try {
    const [[{ acquired }]] = await connection.query(sql("acquire_lock"));
    lockUncertain = false;
    if (acquired !== 1) throw new Error("Could not acquire migration lock");
    locked = true;
    await connection.query(
      migrationSql.replace("__MIGRATION_PROCEDURE__", `\`${name}\``),
    );
    created = true;
    const [result] = await connection.query(sql("call_temporary_procedure"), [
      name,
    ]);
    return { applied: result[0][0].migrated ? ["pdf_expansion@10"] : [] };
  } finally {
    if (lockUncertain) {
      connection.destroy();
    } else {
      try {
        if (created)
          await connection.query(sql("drop_temporary_procedure"), [name]);
      } finally {
        let destroyed = false;
        try {
          if (locked) await releaseNamedLock(connection);
        } catch (error) {
          destroyed = true;
          throw error;
        } finally {
          if (connection !== db && !destroyed) connection.release();
        }
      }
    }
  }
}
