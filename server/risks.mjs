import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError, actorTransaction } from "./db.mjs";
import { bikeRisks } from "./analytics.mjs";

const RULE_VERSION = "risk-v1";
async function ensureHandler(c, actor) {
  if (actor.role === "ADMIN") return;
  if (actor.role !== "OPERATOR")
    throw new AppError("没有风险处置权限", "FORBIDDEN", 403);
  const [[staff]] = await c.query(
    "SELECT s.* FROM staff s JOIN users u ON u.id=s.user_id WHERE s.user_id=? AND s.status='ACTIVE' AND u.status='ACTIVE' AND s.job IN('MAINTENANCE','BOTH')",
    [actor.id],
  );
  if (!staff) throw new AppError("当前岗位不能处理维修风险", "FORBIDDEN", 403);
}
async function audit(c, actor, action, id, detail) {
  await c.query(
    "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?)",
    [actor.id, action, "risk_alerts", id, JSON.stringify(detail)],
  );
}
export function refreshRiskAlerts(pool, actor, now = new Date()) {
  if (actor.role !== "ADMIN")
    throw new AppError("仅管理员可运行风险规则", "FORBIDDEN", 403);
  return actorTransaction(pool, actor, async (c) => {
    const [bikes] = await c.query(
        "SELECT * FROM bikes WHERE status<>'RETIRED'",
      ),
      [tickets] = await c.query("SELECT * FROM maintenance_tickets"),
      results = bikeRisks(bikes, tickets, now).filter((r) => r.score >= 30),
      created = [];
    for (const risk of results) {
      const ticketIds = tickets
          .filter((t) => t.bike_id === risk.bike_id)
          .map((t) => t.id)
          .sort((a, b) => a - b),
        normalized = JSON.stringify({
          bike_id: risk.bike_id,
          version: RULE_VERSION,
          reasons: risk.reasons,
        }),
        fingerprint = createHash("sha256").update(normalized).digest("hex"),
        [row] = await c.query(
          `INSERT IGNORE INTO risk_alerts(bike_id,score,level,reasons,ticket_ids,fingerprint,rule_version,recommendation)
           VALUES(?,?,?,?,?,?,?,'请检查相关部件并结合工单历史确认车辆状态')`,
          [
            risk.bike_id,
            risk.score,
            risk.level,
            JSON.stringify(risk.reason_details),
            JSON.stringify(ticketIds),
            fingerprint,
            RULE_VERSION,
          ],
        );
      if (row.affectedRows) created.push(row.insertId);
    }
    await audit(c, actor, "RISK_REFRESH", null, {
      rule_version: RULE_VERSION,
      evaluated: bikes.length,
      created: created.length,
    });
    return { created, evaluated: bikes.length, rule_version: RULE_VERSION };
  });
}
export function actOnRisk(pool, actor, riskId, action, input = {}) {
  const id = z.coerce.number().int().positive().parse(riskId),
    verb = z
      .enum(["ACKNOWLEDGE", "RESOLVE", "DISMISS", "CREATE_TICKET"])
      .parse(String(action).toUpperCase()),
    note = z.string().trim().min(2).max(500).parse(input.note);
  return actorTransaction(pool, actor, async (c) => {
    await ensureHandler(c, actor);
    const [[risk]] = await c.query(
      "SELECT * FROM risk_alerts WHERE id=? FOR UPDATE",
      [id],
    );
    if (!risk) throw new AppError("风险记录不存在", "NOT_FOUND", 404);
    if (["RESOLVED", "DISMISSED"].includes(risk.status))
      throw new AppError("风险记录已结束", "INVALID_STATE", 409);
    let status = risk.status,
      ticketId = risk.maintenance_ticket_id;
    if (verb === "ACKNOWLEDGE") {
      status = "ACKNOWLEDGED";
      await c.query(
        "UPDATE risk_alerts SET status=?,handler_id=?,resolution_note=?,acknowledged_at=UTC_TIMESTAMP(3) WHERE id=?",
        [status, actor.id, note, id],
      );
    } else if (verb === "CREATE_TICKET") {
      if (!ticketId) {
        const [[open]] = await c.query(
          "SELECT id FROM maintenance_tickets WHERE bike_id=? AND status<>'COMPLETED'",
          [risk.bike_id],
        );
        if (open) ticketId = open.id;
        else {
          const [ticket] = await c.query(
            "INSERT INTO maintenance_tickets(bike_id,reporter_id,fault_type,description) VALUES(?,?,'OTHER',?)",
            [risk.bike_id, actor.id, `风险检查：${note}`],
          );
          ticketId = ticket.insertId;
          await c.query("UPDATE bikes SET status='MAINTENANCE' WHERE id=?", [
            risk.bike_id,
          ]);
        }
      }
      status = "ACKNOWLEDGED";
      await c.query(
        "UPDATE risk_alerts SET status=?,handler_id=?,maintenance_ticket_id=?,resolution_note=?,acknowledged_at=COALESCE(acknowledged_at,UTC_TIMESTAMP(3)) WHERE id=?",
        [status, actor.id, ticketId, note, id],
      );
    } else {
      status = verb === "RESOLVE" ? "RESOLVED" : "DISMISSED";
      await c.query(
        "UPDATE risk_alerts SET status=?,handler_id=?,resolution_note=?,resolved_at=UTC_TIMESTAMP(3) WHERE id=?",
        [status, actor.id, note, id],
      );
    }
    await audit(c, actor, `RISK_${verb}`, id, { note, ticket_id: ticketId });
    return { id, status, maintenance_ticket_id: ticketId };
  });
}
export async function listRiskAlerts(pool) {
  const [rows] = await pool.query(
    `SELECT r.*,b.code bike_code,u.name handler_name,t.status ticket_status
     FROM risk_alerts r JOIN bikes b ON b.id=r.bike_id LEFT JOIN users u ON u.id=r.handler_id
     LEFT JOIN maintenance_tickets t ON t.id=r.maintenance_ticket_id ORDER BY r.id DESC`,
  );
  return rows;
}
