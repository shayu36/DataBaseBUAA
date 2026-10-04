import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url), quiet: true });
if (process.argv[2] !== "shutdown")
  throw new Error("Only shutdown is supported.");
const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
await db.query("SHUTDOWN");
await db.end();
console.log("Project MySQL shut down cleanly.");
