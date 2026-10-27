import { readFile } from "node:fs/promises";
import { applyFeatureMigrations } from "../backend/feature-migrations.mjs";

const procedureFiles = [
  "campus.sql",
  "rides.sql",
  "dispatch.sql",
  "maintenance.sql",
  "admin.sql",
  "reports.sql",
];

async function* statements(url) {
  const text = await readFile(url, "utf8");
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
  if (statement.trim()) throw new Error(`Unterminated SQL statement: ${url}`);
}

export async function applyProcedures(connection) {
  for (const file of procedureFiles) {
    for await (const sql of statements(
      new URL(`../database/procedures/${file}`, import.meta.url),
    )) {
      await connection.query(sql);
    }
  }
}

export async function applySchema(connection) {
  await applyFeatureMigrations(connection);
  for await (const sql of statements(
    new URL("../database/schema.sql", import.meta.url),
  )) {
    await connection.query(sql);
  }
  await applyFeatureMigrations(connection);
  await applyProcedures(connection);
}
