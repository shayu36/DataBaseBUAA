import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../database/read-queries.sql", import.meta.url),
  "utf8",
);
const parts = source.split(/^-- name: ([a-z_]+)\s*$/m);
const statements = new Map();
for (let i = 1; i < parts.length; i += 2) {
  const name = parts[i],
    statement = parts[i + 1].trim();
  if (!statement || statements.has(name))
    throw new Error(`Invalid SQL statement: ${name}`);
  statements.set(name, statement);
}
export function sql(name) {
  const statement = statements.get(name);
  if (!statement) throw new Error(`Unknown SQL statement: ${name}`);
  return statement;
}
