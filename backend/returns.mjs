import { z } from "zod";
import { sql } from "./sql-statements.mjs";
import { AppError, actorTransaction, callProcedure } from "./db.mjs";
import { pageById } from "./pagination.mjs";

export function reviewReturnAttempt(pool, actor, attemptId, input) {
  if (actor.role !== "ADMIN")
    throw new AppError("仅管理员可处理违规还车记录", "FORBIDDEN", 403);
  const id = z.coerce.number().int().positive().parse(attemptId),
    data = z
      .object({
        action: z.enum(["RESOLVE", "DISMISS"]),
        note: z.string().trim().min(2).max(300),
      })
      .parse(input);
  return actorTransaction(pool, actor, (connection) =>
    callProcedure(
      connection,
      "CALL sp_review_return_attempt(?,?,?,?)",
      [actor.id, id, data.action, data.note],
      {
        ATTEMPT_NOT_FOUND: ["违规记录不存在", "NOT_FOUND", 404],
        ATTEMPT_ALREADY_REVIEWED: ["违规记录已处理", "INVALID_STATE", 409],
      },
    ),
  );
}

export async function listReturnAttempts(pool, actor, before = null, scope) {
  if (scope === "all" && actor.role !== "ADMIN")
    throw new AppError("没有查看全部归还记录的权限", "FORBIDDEN", 403);
  const admin = actor.role === "ADMIN" && scope !== "own";
  const [rows] = await pool.query(
    sql(admin ? "return_attempts_all" : "return_attempts_own"),
    admin ? [before, before] : [actor.id, before, before],
  );
  return pageById(rows, "attempts");
}
