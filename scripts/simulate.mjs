import { createPool } from "../backend/db.mjs";
import { seedSimulation } from "../backend/demo-seed.mjs";

if (process.env.DB_NAME !== "campus_bike")
  throw new Error("模拟数据命令仅支持 campus_bike 数据库");
const pool = createPool();
const admin = createPool({
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
try {
  console.log(JSON.stringify(await seedSimulation(pool, admin)));
  console.log(
    "模拟数据已就绪：共 123 名用户、200 辆单车；重复执行不会重复新增",
  );
} catch (error) {
  if (
    ["ER_BAD_DB_ERROR", "ER_NO_SUCH_TABLE"].includes(error.code) ||
    error.sqlMessage === "SIMULATION_BASE_REQUIRED"
  )
    throw new Error("基础演示库尚未就绪，请先运行 npm run db:seed", {
      cause: error,
    });
  throw error;
} finally {
  await Promise.all([pool.end(), admin.end()]);
}
