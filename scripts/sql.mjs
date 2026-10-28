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

async function assertTriggerCatalogueSlot(connection) {
  const [[{ available }]] = await connection.query(
    sql("trigger_catalogue_slot_available"),
  );
  if (!available)
    throw new Error(
      "TRIGGER_CATALOGUE_CONFLICT：触发器目录配置与已有数据冲突，请核对后重试。",
    );
}

export async function refreshTriggerCatalogue(connection) {
  await assertTriggerCatalogueSlot(connection);
  await connection.query(sql("refresh_trigger_catalogue"));
  await assertTriggerCatalogueSlot(connection);
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
      await refreshTriggerCatalogue(connection);
      await applyProcedures(connection);
    }),
  );
}
