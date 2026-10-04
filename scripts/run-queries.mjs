import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { join } from "node:path";
import { runMysqlTool, projectRoot } from "./mysql-tools.mjs";
const folder = join(projectRoot, "docs", "evidence");
await mkdir(folder, { recursive: true });
const output = createWriteStream(join(folder, "sql-query-results.txt"));
await runMysqlTool(
  "mysql",
  ["--default-character-set=utf8mb4", "--table", process.env.DB_NAME],
  {
    input: createReadStream(join(projectRoot, "database", "queries.sql")),
    output,
  },
);
await finished(output);
console.log(
  "All 20 SQL query groups executed; output saved to docs/evidence/sql-query-results.txt",
);
