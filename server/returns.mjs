import { z } from "zod";
import { AppError, actorTransaction } from "./db.mjs";

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
  return actorTransaction(pool, actor, async (c) => {
    const [[row]] = await c.query(
      "SELECT * FROM return_attempts WHERE id=? FOR UPDATE",
      [id],
    );
    if (!row) throw new AppError("违规记录不存在", "NOT_FOUND", 404);
    if (row.review_status !== "PENDING")
      throw new AppError("违规记录已处理", "INVALID_STATE", 409);
    const status = data.action === "RESOLVE" ? "RESOLVED" : "DISMISSED";
    await c.query(
      "UPDATE return_attempts SET review_status=?,reviewer_id=?,review_note=?,reviewed_at=UTC_TIMESTAMP(3) WHERE id=?",
      [status, actor.id, data.note, id],
    );
    await c.query(
      "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?)",
      [
        actor.id,
        "RETURN_ATTEMPT_" + status,
        "return_attempts",
        id,
        JSON.stringify(data),
      ],
    );
    return { id, review_status: status };
  });
}

export async function listReturnAttempts(pool, actor) {
  const where = actor.role === "ADMIN" ? "" : "WHERE r.user_id=?";
  const [rows] = await pool.query(
    `SELECT a.*,r.user_id,b.code bike_code,z.name zone_name,u.name reviewer_name
     FROM return_attempts a JOIN ride_orders r ON r.id=a.order_id JOIN bikes b ON b.id=r.bike_id
     JOIN parking_zones z ON z.id=a.zone_id LEFT JOIN users u ON u.id=a.reviewer_id
     ${where} ORDER BY a.id DESC LIMIT 200`,
    actor.role === "ADMIN" ? [] : [actor.id],
  );
  return rows;
}
