import mysql from "mysql2/promise";
import { sql } from "../backend/sql-statements.mjs";

// Verify an existing account before granting access to the application database.
export async function initializeAccount(
  admin,
  options,
  connect = mysql.createConnection,
) {
  await admin.query(sql("create_application_user"), [options.password]);
  const app = await connect(options);
  try {
    const [[{ account }]] = await app.query(sql("current_account"));
    if (account !== "qingxing_app@localhost")
      throw new Error("应用账号未匹配预期的本机 MySQL 账号，停止授权。");
  } finally {
    await app.end();
  }
  await admin.query(sql("grant_application_user"));
}
