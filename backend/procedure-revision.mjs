import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const files = [
  "campus.sql",
  "rides.sql",
  "dispatch.sql",
  "maintenance.sql",
  "admin.sql",
  "reports.sql",
];

export async function loadProcedureSources() {
  return Promise.all(
    files.map(async (name) => ({
      name,
      text: await readFile(
        new URL(`../database/procedures/${name}`, import.meta.url),
        "utf8",
      ),
    })),
  );
}

export function procedureRevision(sources) {
  const hash = createHash("sha256");
  for (const { name, text } of sources)
    hash
      .update(name)
      .update("\0")
      .update(text.replaceAll("\r\n", "\n"))
      .update("\0");
  return hash.digest("hex");
}
