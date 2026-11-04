import { existsSync } from "node:fs";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { sql } from "../backend/sql-statements.mjs";
import { assertMysqlVersion } from "./mysql-version.mjs";
import { sessionSecret } from "../backend/config.mjs";
import { initializeAccount } from "./bootstrap-account.mjs";
import { databaseStartupError } from "../backend/database-errors.mjs";

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
const missing = required.filter(
  (name) =>
    !process.env[name]?.trim() ||
    process.env[name].trimStart().startsWith("replace-with-"),
);
if (missing.length) {
  throw new Error(
    `请在 .env 中填写或替换以下配置：${missing.join("、")}。DB_ADMIN_USER、DB_ADMIN_PASSWORD 是 MySQL 管理员凭据，不是网页演示账号；生成 JWT_SECRET 的命令只会打印结果，须将其写入 .env。`,
  );
}
sessionSecret();
if (
  !["127.0.0.1", "localhost"].includes(process.env.DB_HOST) ||
  process.env.DB_NAME !== "campus_bike" ||
  process.env.DB_USER !== "qingxing_app"
) {
  throw new Error(
    "自动初始化要求 DB_HOST 为 127.0.0.1 或 localhost、DB_NAME 为 campus_bike、DB_USER 为 qingxing_app。MySQL 管理员账号请填写到 DB_ADMIN_USER，不要替换 DB_USER。",
  );
}
const connection = await mysql
  .createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD,
  })
  .catch((error) => {
    throw databaseStartupError(error, { account: "administrator" });
  });
try {
  await assertMysqlVersion(connection);
  for (const name of ["campus_bike", "campus_bike_test"]) {
    await connection.query(sql("create_application_database"), [name]);
  }
  await initializeAccount(connection, {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
} finally {
  await connection.end();
}
const app = await mysql
  .createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  })
  .catch((error) => {
    throw databaseStartupError(error);
  });
await app.end();
console.log("MySQL 数据库和应用账号已就绪。");
