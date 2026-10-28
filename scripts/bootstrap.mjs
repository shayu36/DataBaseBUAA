import { existsSync } from "node:fs";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { sql } from "../backend/sql-statements.mjs";
import { assertMysqlVersion } from "./mysql-version.mjs";
import { sessionSecret } from "../backend/config.mjs";

const envPath = new URL("../.env", import.meta.url);
if (!existsSync(envPath)) {
  throw new Error(
    "缺少 .env：请复制 .env.example 并填写本机 MySQL 管理员和应用账号密码。",
  );
}
dotenv.config({ path: envPath, quiet: true });
const required = [
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "DB_ADMIN_USER",
  "DB_ADMIN_PASSWORD",
  "JWT_SECRET",
];
if (
  required.some(
    (name) =>
      !process.env[name] || process.env[name].startsWith("replace-with-"),
  )
) {
  throw new Error("请在 .env 中填写完整的 MySQL 凭据和 JWT_SECRET。");
}
sessionSecret();
if (
  !["127.0.0.1", "localhost"].includes(process.env.DB_HOST) ||
  process.env.DB_NAME !== "campus_bike" ||
  process.env.DB_USER !== "qingxing_app"
) {
  throw new Error(
    "自动初始化仅支持本机 MySQL、campus_bike 数据库及 qingxing_app 账号。",
  );
}
const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
try {
  await assertMysqlVersion(connection);
  for (const name of ["campus_bike", "campus_bike_test"]) {
    await connection.query(sql("create_application_database"), [name]);
  }
  await connection.query(sql("create_application_user"), [
    process.env.DB_PASSWORD,
  ]);
  await connection.query(sql("grant_application_user"));
} finally {
  await connection.end();
}
const app = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
await app.end();
console.log("MySQL 数据库和应用账号已就绪。");
