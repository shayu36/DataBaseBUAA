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

// Report nested error types without including SQL parameters or other error data.
export function errorCodes(error) {
  if (error instanceof AggregateError) return error.errors.flatMap(errorCodes);
  return [String(error?.code || error?.name || "UNKNOWN")];
}

// GET_LOCK is connection-scoped, including across DDL implicit commits.
export function withNamedLock(db, work) {
  return withLock(db, work, "acquire_lock", "release_lock");
}
export function withSchemaLock(db, work) {
  return withLock(db, work, "acquire_schema_lock", "release_schema_lock");
}
async function withLock(db, work, acquire, release) {
  const pooled = typeof db.getConnection === "function";
  const connection = pooled ? await db.getConnection() : db;
  let locked = false,
    lockUncertain = true,
    destroyed = false,
    failed = false,
    failure;
  const discard = () => {
    destroyed = true;
    connection.destroy();
  };
  try {
    const [[{ acquired }]] = await connection.query(sql(acquire));
    lockUncertain = false;
    if (acquired !== 1)
      throw new AppError("业务服务繁忙，请稍后重试", "BUSY", 503);
    locked = true;
    return await work(connection, discard);
  } catch (error) {
    failed = true;
    failure = error;
    if (lockUncertain) discard();
    throw error;
  } finally {
    if (!destroyed) {
      if (locked) {
        try {
          await releaseLock(connection, release);
        } catch (releaseError) {
          if (failed)
            throw new AggregateError(
              [failure, releaseError],
              "数据库操作及锁释放均失败",
            );
          throw releaseError;
        }
      }
      if (pooled) connection.release();
    }
  }
}

// A course-scale single-writer transaction boundary, with locks on affected rows.
export function ledgerTransaction(pool, work) {
  return withNamedLock(pool, async (connection, discard) => {
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        discard();
        throw new AggregateError(
          [error, rollbackError],
          "数据库回滚失败，连接已关闭",
        );
      }
      throw error;
    }
  });
}

// A connection must not be reused if releasing its named lock cannot be confirmed.
async function releaseLock(connection, statement) {
  try {
    const [[{ released }]] = await connection.query(sql(statement));
    if (released !== 1) throw new Error("数据库事务锁未正确释放");
  } catch (error) {
    connection.destroy();
    throw error;
  }
}

// A single MVCC snapshot keeps multi-query read models internally consistent.
export async function readSnapshot(pool, work) {
  const connection = await pool.getConnection();
  let setup = true,
    destroyed = false;
  try {
    await connection.query(sql("repeatable_read"));
    await connection.query(sql("consistent_snapshot"));
    setup = false;
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    if (setup) {
      destroyed = true;
      connection.destroy();
    } else {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        destroyed = true;
        connection.destroy();
        throw new AggregateError(
          [error, rollbackError],
          "数据库回滚失败，连接已关闭",
        );
      }
    }
    throw error;
  } finally {
    if (!destroyed) connection.release();
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

export function translateDatabaseError(error) {
  if (
    error?.code === "ER_SIGNAL_EXCEPTION" &&
    error.sqlMessage === "INVALID_CARBON_RULE"
  )
    return new AppError(
      "碳积分规则配置无效，请联系管理员",
      "INVALID_CARBON_RULE",
      503,
    );
  if (
    error?.code === "ER_SIGNAL_EXCEPTION" &&
    error.sqlMessage === "CARBON_AWARD_OUT_OF_RANGE"
  )
    return new AppError(
      "该行程按当前碳积分规则计算的结果超出系统范围，请联系管理员",
      "CARBON_AWARD_OUT_OF_RANGE",
      503,
    );
  return error;
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
    throw translateDatabaseError(error);
  }
}
