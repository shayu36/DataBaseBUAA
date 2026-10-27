import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { sql } from "./sql-statements.mjs";
dotenv.config({ path: new URL("../.env", import.meta.url), quiet: true });

export function createPool(overrides = {}) {
  return mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
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
  let locked = false;
  try {
    const [[{ acquired }]] = await connection.query(sql("acquire_lock"));
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
    if (locked) await releaseNamedLock(connection);
    connection.release();
  }
}

// A connection must not be reused if releasing its named lock cannot be confirmed.
export async function releaseNamedLock(connection) {
  try {
    const [[{ released }]] = await connection.query(sql("release_lock"));
    if (released !== 1) throw new Error("数据库事务锁未正确释放");
  } catch (error) {
    connection.destroy();
    throw error;
  }
}

// A single MVCC snapshot keeps multi-query read models internally consistent.
export async function readSnapshot(pool, work) {
  const connection = await pool.getConnection();
  try {
    await connection.query(sql("repeatable_read"));
    await connection.query(sql("consistent_snapshot"));
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// HTTP authentication can precede a lock wait or password hashing. Revalidate
// identity inside the transaction before any authorized state change occurs.
export function actorTransaction(pool, actor, work) {
  return ledgerTransaction(pool, async (connection) => {
    const [[current]] = await connection.query(sql("actor_for_update"), [
      actor.id,
    ]);
    if (!current || current.status !== "ACTIVE" || current.role !== actor.role)
      throw new AppError(
        "账号状态或权限已发生变化，请重新登录",
        "FORBIDDEN",
        403,
      );
    return work(connection);
  });
}

// MySQL signals stable business codes; the API owns localized messages.
export async function callProcedure(
  connection,
  statement,
  params,
  errors = {},
) {
  try {
    const [results] = await connection.query(statement, params);
    return results[0][0];
  } catch (error) {
    const details =
      error.code === "ER_SIGNAL_EXCEPTION" && errors[error.sqlMessage];
    if (details) throw new AppError(...details);
    throw error;
  }
}
