import { readFile } from "node:fs/promises";
import { createPool } from "../backend/db.mjs";
import { sql } from "../backend/sql-statements.mjs";
import { campus, campusDefinition } from "../backend/campus-data.mjs";
const pool = createPool(
  process.argv[2]
    ? {
        database: process.argv[2],
        user: process.env.DB_ADMIN_USER,
        password: process.env.DB_ADMIN_PASSWORD,
      }
    : {},
);
const checks = await readFile(
  new URL("../database/invariant-checks.sql", import.meta.url),
  "utf8",
);
const c = await pool.getConnection();
try {
  await c.query(sql("consistent_snapshot"));
  let errors = 0;
  const [results] = await c.query(checks);
  for (const result of results) {
    errors += Number(result.errors);
    console.log(
      (Number(result.errors) === 0 ? "PASS " : "FAIL ") +
        result.name +
        ": " +
        result.errors,
    );
  }
  const [[totals]] = await c.query(sql("check_totals"));
  console.log(JSON.stringify(totals));
  const [[map]] = await c.query(sql("campus_map_compatible"), [campus.version]);
  if (map.compatible) {
    const [differences] = await c.query(sql("campus_restriction_differences"), [
      campusDefinition,
    ]);
    if (differences.length) {
      console.warn(
        `WARN ${differences.length} 条默认禁行路段与当前数据库不同，请人工核对；检查不会更改道路。`,
      );
      for (const road of differences)
        console.warn(
          `  节点 ${road.from_id} → ${road.to_id}（${road.from_name ?? "不存在"} → ${road.to_name ?? "不存在"}），路段 ${road.id ?? "不存在"}，当前状态 ${road.status ?? "不存在"}`,
        );
    }
  } else {
    console.warn("WARN 校园地图版本与当前代码不同，未比较默认禁行路段。");
  }
  await c.commit();
  if (errors) process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
