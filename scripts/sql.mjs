import { readFile } from "node:fs/promises";
import { applyFeatureMigrations } from "../server/feature-migrations.mjs";
export async function applySchema(connection) {
  await applyFeatureMigrations(connection);
  const text = await readFile(
    new URL("../database/schema.sql", import.meta.url),
    "utf8",
  );
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
      if (sql) await connection.query(sql);
      statement = "";
    }
  }
  if (statement.trim()) throw new Error("Unterminated SQL statement");
  await applyFeatureMigrations(connection);
}
