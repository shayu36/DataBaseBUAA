import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
const root = fileURLToPath(new URL("../", import.meta.url));
const envPath = `${root}.env`;
if (!existsSync(envPath)) {
  writeFileSync(
    envPath,
    `HOST=127.0.0.1\nPORT=5188\nDB_HOST=127.0.0.1\nDB_PORT=3377\nDB_USER=qingxing_app\nDB_PASSWORD=${randomBytes(24).toString("hex")}\nDB_NAME=campus_bike\nDB_ADMIN_USER=root\nDB_ADMIN_PASSWORD=${randomBytes(24).toString("hex")}\nJWT_SECRET=${randomBytes(48).toString("hex")}\nCOOKIE_SECURE=false\n`,
  );
}
dotenv.config({ path: envPath, quiet: true });
let connection;
const base = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: "root",
};
try {
  connection = await mysql.createConnection({
    ...base,
    password: process.env.DB_ADMIN_PASSWORD,
  });
} catch (error) {
  if (error.code !== "ER_ACCESS_DENIED_ERROR") throw error;
  connection = await mysql.createConnection({ ...base, password: "" });
  await connection.query(`ALTER USER 'root'@'localhost' IDENTIFIED BY ?`, [
    process.env.DB_ADMIN_PASSWORD,
  ]);
}
try {
  for (const name of ["campus_bike", "campus_bike_test"]) {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  }
  await connection.query(
    `CREATE USER IF NOT EXISTS 'qingxing_app'@'localhost' IDENTIFIED BY ?`,
    [process.env.DB_PASSWORD],
  );
  await connection.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON campus_bike.* TO 'qingxing_app'@'localhost'`,
  );
  console.log(
    "Local credentials configured; application user is restricted to campus_bike.",
  );
} finally {
  await connection.end();
}
