import { z } from "zod";
import { AppError, actorTransaction } from "./db.mjs";
import {
  requireAdmin,
  createDispatchInConnection,
  audit,
} from "./business.mjs";
import { aggregateHotspots, dispatchSuggestions } from "./analytics.mjs";

export const reportFilterSchema = z
  .object({
    days: z.coerce
      .number()
      .int()
      .refine((v) => [7, 30].includes(v))
      .optional(),
    start: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    end: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    dayType: z.enum(["ALL", "WEEKDAY", "WEEKEND"]).default("ALL"),
    startHour: z.coerce.number().int().min(0).max(23).default(0),
    endHour: z.coerce.number().int().min(1).max(24).default(24),
    zoneId: z.coerce.number().int().positive().optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.start && !v.end) || (!v.start && v.end))
      ctx.addIssue({ code: "custom", message: "起止日期必须同时提供" });
    if (v.startHour >= v.endHour)
      ctx.addIssue({ code: "custom", message: "结束小时必须晚于开始小时" });
    if (v.start && v.end) {
      const start = new Date(v.start + "T00:00:00+08:00").getTime(),
        end = new Date(v.end + "T00:00:00+08:00").getTime();
      if (end < start)
        ctx.addIssue({ code: "custom", message: "结束日期不能早于开始日期" });
      if (end - start >= 31 * 86400000)
        ctx.addIssue({ code: "custom", message: "自定义区间最多 31 天" });
    }
  })
  .transform((v) =>
    v.start
      ? {
          start: v.start,
          end: v.end,
          dayType: v.dayType,
          startHour: v.startHour,
          endHour: v.endHour,
          zoneId: v.zoneId,
        }
      : (v.days ?? 7),
  );

async function analyticsRows(c) {
  const [zones] = await c.query("SELECT * FROM v_zone_inventory ORDER BY id");
  const [rides] = await c.query("SELECT * FROM ride_orders");
  const [snapshots] = await c.query(
    "SELECT * FROM zone_snapshots ORDER BY captured_at",
  );
  return { zones, rides, snapshots };
}

export async function createDispatchSuggestions(pool, actor, rawFilter) {
  requireAdmin(actor);
  const filter = reportFilterSchema.parse(rawFilter);
  return actorTransaction(pool, actor, async (c) => {
    const { zones, rides, snapshots } = await analyticsRows(c);
    const report = aggregateHotspots(zones, rides, snapshots, filter);
    const suggestions = dispatchSuggestions(zones, report.hotspots);
    const created = [];
    for (const s of suggestions) {
      const source = zones.find((z) => z.id === s.source_zone_id),
        target = zones.find((z) => z.id === s.target_zone_id),
        demand = report.hotspots.find((h) => h.zone_id === target.id);
      const [row] = await c.query(
        `INSERT INTO dispatch_suggestions(source_zone_id,target_zone_id,quantity,source_available,target_occupied,target_capacity,target_reserved,borrow_count,return_count,desired_inventory,window_start,window_end,reason,algorithm_version,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'demand-balance-v1',?)`,
        [
          source.id,
          target.id,
          s.quantity,
          source.available,
          target.occupied,
          target.capacity,
          target.reserved,
          demand?.borrow_count || 0,
          demand?.return_count || 0,
          s.desired_inventory,
          report.filter.start.slice(0, 23).replace("T", " ").replace("Z", ""),
          report.filter.end.slice(0, 23).replace("T", " ").replace("Z", ""),
          s.reason,
          actor.id,
        ],
      );
      created.push({ id: row.insertId, ...s, status: "OPEN" });
    }
    await audit(
      c,
      actor,
      "SUGGESTIONS_GENERATE",
      "dispatch_suggestions",
      null,
      {
        filter,
        count: created.length,
      },
    );
    return { suggestions: created, filter: report.filter };
  });
}

export async function listDispatchSuggestions(pool) {
  const [rows] = await pool.query(
    `SELECT s.*,a.name source_name,b.name target_name
     FROM dispatch_suggestions s JOIN parking_zones a ON a.id=s.source_zone_id JOIN parking_zones b ON b.id=s.target_zone_id
     ORDER BY s.id DESC LIMIT 100`,
  );
  return rows;
}

export async function confirmDispatchSuggestion(pool, actor, id, staffId) {
  requireAdmin(actor);
  const result = await actorTransaction(pool, actor, async (c) => {
    const [[suggestion]] = await c.query(
      "SELECT * FROM dispatch_suggestions WHERE id=? FOR UPDATE",
      [z.coerce.number().int().positive().parse(id)],
    );
    if (!suggestion) throw new AppError("调度建议不存在", "NOT_FOUND", 404);
    if (suggestion.status !== "OPEN")
      throw new AppError("调度建议已处理", "SUGGESTION_NOT_OPEN", 409);
    const [[source]] = await c.query(
      "SELECT * FROM v_zone_inventory WHERE id=?",
      [suggestion.source_zone_id],
    );
    const [[target]] = await c.query(
      "SELECT * FROM v_zone_inventory WHERE id=?",
      [suggestion.target_zone_id],
    );
    const [bikes] = await c.query(
      "SELECT id FROM bikes WHERE current_zone_id=? AND status='AVAILABLE' ORDER BY id LIMIT ? FOR UPDATE",
      [suggestion.source_zone_id, suggestion.quantity],
    );
    const free =
      Number(target.capacity) -
      Number(target.occupied) -
      Number(target.reserved);
    if (
      source.status !== "ACTIVE" ||
      target.status !== "ACTIVE" ||
      bikes.length < suggestion.quantity ||
      free < suggestion.quantity
    ) {
      const note = `当前源站可调 ${bikes.length} 辆，目标空位 ${Math.max(0, free)} 个`;
      await c.query(
        "UPDATE dispatch_suggestions SET status='STALE',resolution_note=?,resolved_at=UTC_TIMESTAMP(3) WHERE id=?",
        [note, suggestion.id],
      );
      await audit(
        c,
        actor,
        "SUGGESTION_STALE",
        "dispatch_suggestions",
        suggestion.id,
        {
          note,
        },
      );
      return { stale: note };
    }
    const task = await createDispatchInConnection(c, actor, {
      source_zone_id: suggestion.source_zone_id,
      target_zone_id: suggestion.target_zone_id,
      bike_ids: bikes.map((b) => b.id),
      staff_id: staffId,
    });
    await c.query(
      "UPDATE dispatch_suggestions SET status='CONFIRMED',task_id=?,resolved_at=UTC_TIMESTAMP(3) WHERE id=?",
      [task.id, suggestion.id],
    );
    return { ...task, suggestion_id: suggestion.id };
  });
  if (result.stale)
    throw new AppError(`建议已过期：${result.stale}`, "SUGGESTION_STALE", 409);
  return result;
}
