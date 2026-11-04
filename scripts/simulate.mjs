import { createPool } from "../backend/db.mjs";
import { seedSimulation } from "../backend/demo-seed.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => argument !== "--append"))
  throw new Error("用法：npm run db:simulate [-- --append]");
if (process.env.DB_NAME !== "campus_bike")
  throw new Error("模拟数据命令仅支持 campus_bike 数据库");
const pool = createPool();
const admin = createPool({
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
try {
  const result = await seedSimulation(pool, admin, {
    append: args.includes("--append"),
  });
  console.log(JSON.stringify(result));
  console.log(
    `模拟数据已就绪：当前 ${result.users} 名用户、${result.bikes} 辆单车；重复执行不会重复新增`,
  );
} catch (error) {
  if (
    ["ER_BAD_DB_ERROR", "ER_NO_SUCH_TABLE"].includes(error.code) ||
    error.sqlMessage === "SIMULATION_BASE_REQUIRED"
  )
    throw new Error("基础演示库尚未就绪，请先运行 npm run db:seed");
  throw new Error(
    `模拟数据导入失败：${error.sqlMessage || error.code || error.message}`,
  );
} finally {
  await Promise.all([pool.end(), admin.end()]);
}
