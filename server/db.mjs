import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url), quiet: true });

export function createPool(overrides = {}) {
  return mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3377),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "campus_bike",
    connectionLimit: 12,
    timezone: "Z",
    // Coordinates, bounded aggregate counts and simulated carbon values fit
    // safely in JS numbers. Currency itself is stored as integer cents.
    decimalNumbers: true,
    charset: "utf8mb4",
    ...overrides,
  });
}
export class AppError extends Error {
  constructor(message, code = "INVALID_INPUT", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// A course-scale single-writer transaction boundary, with locks on affected rows.
// GET_LOCK is connection-scoped, so it must always be released before pool return.
export async function ledgerTransaction(pool, work) {
  const connection = await pool.getConnection();
  let lockName,
    locked = false;
  try {
    const [[{ name }]] = await connection.query("SELECT DATABASE() name");
    lockName = `campus-bike:${name}`;
    const [[{ acquired }]] = await connection.query(
      "SELECT GET_LOCK(?,10) acquired",
      [lockName],
    );
    if (acquired !== 1)
      throw new AppError("业务服务繁忙，请稍后重试", "BUSY", 503);
    locked = true;
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
    connection.release();
  }
}

// HTTP authentication can precede a lock wait or password hashing. Revalidate
// identity inside the transaction before any authorized state change occurs.
export function actorTransaction(pool, actor, work) {
  return ledgerTransaction(pool, async (connection) => {
    const [[current]] = await connection.query(
      "SELECT role,status FROM users WHERE id=? FOR UPDATE",
      [actor.id],
    );
    if (!current || current.status !== "ACTIVE" || current.role !== actor.role)
      throw new AppError(
        "账号状态或权限已发生变化，请重新登录",
        "FORBIDDEN",
        403,
      );
    return work(connection);
  });
}
