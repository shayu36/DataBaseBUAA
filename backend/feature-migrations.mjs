import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "./sql-statements.mjs";

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
  try {
    const [[{ acquired }]] = await connection.query(sql("acquire_lock"));
    if (acquired !== 1) throw new Error("Could not acquire migration lock");
    locked = true;
    await connection.query(
      migrationSql.replace("__MIGRATION_PROCEDURE__", `\`${name}\``),
    );
    created = true;
    const [result] = await connection.query(sql("call_temporary_procedure"), [
      name,
    ]);
    return { applied: result[0][0].migrated ? ["pdf_expansion@8"] : [] };
  } finally {
    try {
      if (created)
        await connection.query(sql("drop_temporary_procedure"), [name]);
    } finally {
      try {
        if (locked) await connection.query(sql("release_lock"));
      } finally {
        if (connection !== db) connection.release();
      }
    }
  }
}
