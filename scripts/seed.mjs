import { createPool, ledgerTransaction } from "../backend/db.mjs";
import { upgradeCampusMap } from "../backend/campus.mjs";
import { seedDemo } from "../backend/demo-seed.mjs";

function seedStartupError(error) {
  if (!process.env.DB_NAME)
    return new Error(
      "缺少本机配置文件 .env。请在项目根目录运行 npm run db:seed 完成数据库初始化。",
      { cause: error },
    );
  if (error?.code === "ECONNREFUSED")
    return new Error(
      `无法连接项目数据库 ${process.env.DB_HOST || "127.0.0.1"}:${process.env.DB_PORT || "3306"}。请运行 npm run db:seed 初始化数据库（请先启动本机 MySQL）；不要直接执行 node scripts/seed.mjs。`,
      { cause: error },
    );
  if (
    error?.code === "ER_ACCESS_DENIED_ERROR" ||
    error?.code === "ER_ACCESS_DENIED_NO_PASSWORD_ERROR"
  )
    return new Error(
      "项目数据库凭据不匹配。请保留本机 .env，并运行 npm run db:seed 重新配置项目数据库账户。",
      { cause: error },
    );
  if (error?.code === "ER_BAD_DB_ERROR" || error?.code === "ER_NO_SUCH_TABLE")
    return new Error(
      "项目数据库结构尚未就绪。请运行 npm run db:seed，它会依次建库、建表、迁移并写入演示数据。",
      { cause: error },
    );
  return error;
}

const pool = createPool();
const adminPool = createPool({
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
try {
  if (process.env.DB_NAME !== "campus_bike")
    throw new Error("Seeding is restricted to campus_bike.");
  const seeded = await seedDemo(pool, adminPool);
  console.log(
    seeded
      ? "Seeded: 6 parking zones, 66 bikes, 4 accounts, connected road network and labeled demo history."
      : "Campus demo already seeded; existing data preserved.",
  );
  const migrated = await ledgerTransaction(pool, upgradeCampusMap);
  if (migrated)
    console.log(
      "Updated campus map to Beihang Xueyuan Road; historical ledgers preserved.",
    );
} catch (error) {
  throw seedStartupError(error);
} finally {
  await Promise.all([pool.end(), adminPool.end()]);
}
