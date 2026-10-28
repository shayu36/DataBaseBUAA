import { z } from "zod";
import { sql } from "./sql-statements.mjs";
import { AppError, actorTransaction, callProcedure } from "./db.mjs";
import { riskData } from "./risk-data.mjs";
import { pageById } from "./pagination.mjs";

const RULE_VERSION = "risk-v1";
export function refreshRiskAlerts(pool, actor, now = new Date()) {
  if (actor.role !== "ADMIN")
    throw new AppError("仅管理员可运行风险规则", "FORBIDDEN", 403);
  return actorTransaction(pool, actor, async (c) => {
    const { risks, evaluated } = await riskData(c, now);
    const [result] = await c.query("CALL sp_refresh_risk_alerts(?,?,?,?,?)", [
      actor.id,
      evaluated,
      RULE_VERSION,
      now,
      JSON.stringify(risks),
    ]);
    return {
      created: result[0].map((row) => row.id),
      evaluated,
      rule_version: RULE_VERSION,
    };
  });
}
export function actOnRisk(pool, actor, riskId, action, input = {}) {
  const id = z.coerce.number().int().positive().parse(riskId),
    verb = z
      .enum(["ACKNOWLEDGE", "RESOLVE", "DISMISS", "CREATE_TICKET"])
      .parse(String(action).toUpperCase()),
    note = z.string().trim().min(2).max(500).parse(input.note);
  return actorTransaction(pool, actor, (connection) =>
    callProcedure(
      connection,
      "CALL sp_act_on_risk(?,?,?,?)",
      [actor.id, id, verb, note],
      {
        RISK_HANDLER_FORBIDDEN: ["当前岗位不能处理维修风险", "FORBIDDEN", 403],
        RISK_NOT_FOUND: ["风险记录不存在", "NOT_FOUND", 404],
        RISK_CLOSED: ["风险记录已结束", "INVALID_STATE", 409],
        RISK_BIKE_UNAVAILABLE: [
          "车辆正在调度或已退役，无法创建维修工单",
          "INVALID_STATE",
          409,
        ],
      },
    ),
  );
}
export async function listRiskAlerts(pool, before = null) {
  const [rows] = await pool.query(sql("risk_alerts"), [before, before]);
  return pageById(rows, "risks");
}
