import { readFile } from "node:fs/promises";
import { applyFeatureMigrationsLocked } from "../backend/feature-migrations.mjs";
import { withNamedLock, withSchemaLock } from "../backend/db.mjs";
import { sql } from "../backend/sql-statements.mjs";
import {
  loadProcedureSources,
  procedureRevision,
} from "../backend/procedure-revision.mjs";

function* statements(text, name) {
  let delimiter = ";",
    statement = "";
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("--")) continue;
    if (/^DELIMITER /i.test(line)) {
      delimiter = line.split(" ")[1].trim();
      continue;
    }
    statement += line + "\n";
    if (statement.trimEnd().endsWith(delimiter)) {
      const sql = statement.trimEnd().slice(0, -delimiter.length).trim();
      if (sql) yield sql;
      statement = "";
    }
  }
  if (statement.trim()) throw new Error(`Unterminated SQL statement: ${name}`);
}

export async function applyProcedures(connection) {
  await connection.query(sql("clear_procedure_revision"));
  const sources = await loadProcedureSources();
  for (const source of sources) {
    for (const statement of statements(source.text, source.name)) {
      await connection.query(statement);
    }
  }
  await connection.query(sql("set_procedure_revision"), [
    procedureRevision(sources),
  ]);
}

export function applySchema(pool) {
  return withSchemaLock(pool, (connection) =>
    withNamedLock(connection, async () => {
      await applyFeatureMigrationsLocked(connection, true);
      const schema = new URL("../database/schema.sql", import.meta.url);
      for (const statement of statements(
        await readFile(schema, "utf8"),
        schema,
      )) {
        await connection.query(statement);
      }
      await applyFeatureMigrationsLocked(connection, true);
      await applyProcedures(connection);
    }),
  );
}
