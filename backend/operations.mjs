import { hotspotReport } from "./hotspot-report.mjs";
import { dispatchSuggestions } from "./dispatch-suggestions.mjs";
import { z } from "zod";
import { sql } from "./sql-statements.mjs";
import { AppError, actorTransaction, callProcedure } from "./db.mjs";
import {
  requireAdmin,
  createDispatchInConnection,
  idSchema,
} from "./business.mjs";
import { parseReportingDay } from "./analytics.mjs";

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
      try {
        const start = parseReportingDay(v.start),
          end = parseReportingDay(v.end);
        if (end < start)
          ctx.addIssue({ code: "custom", message: "结束日期不能早于开始日期" });
        if (end - start >= 31 * 86400000)
          ctx.addIssue({ code: "custom", message: "自定义区间最多 31 天" });
        if (start >= Date.now())
          ctx.addIssue({ code: "custom", message: "开始日期不能晚于当前时间" });
      } catch {
        ctx.addIssue({ code: "custom", message: "日期无效" });
      }
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

export async function createDispatchSuggestions(pool, actor, rawFilter) {
  requireAdmin(actor);
  const filter = reportFilterSchema.parse(rawFilter);
  return actorTransaction(pool, actor, async (c) => {
    const now = new Date();
    const { zones, report } = await hotspotReport(c, filter, now);
    const suggestions = await dispatchSuggestions(c, zones, report.hotspots);
    const zonesById = new Map(zones.map((zone) => [zone.id, zone]));
    const demandById = new Map(
      report.hotspots.map((hotspot) => [hotspot.zone_id, hotspot]),
    );
    const candidates = suggestions.map((suggestion) => {
      const source = zonesById.get(suggestion.source_zone_id);
      const target = zonesById.get(suggestion.target_zone_id);
      const demand = demandById.get(target.id);
      return {
        ...suggestion,
        source_available: source.available,
        target_occupied: target.occupied,
        target_capacity: target.capacity,
        target_reserved: target.reserved,
        borrow_count: demand?.borrow_count || 0,
        return_count: demand?.return_count || 0,
      };
    });
    const [rows] = await c.query(
      "CALL sp_save_dispatch_suggestions(?,?,?,?,?)",
      [
        actor.id,
        JSON.stringify(filter),
        new Date(report.filter.start),
        new Date(report.filter.end),
        JSON.stringify(candidates),
      ],
    );
    const created = rows[0].map((row, index) => ({
      id: row.id,
      ...suggestions[index],
      status: "OPEN",
    }));
    return { suggestions: created, filter: report.filter };
  });
}

export async function listDispatchSuggestions(pool) {
  const [rows] = await pool.query(sql("dispatch_suggestions"));
  return rows;
}

export async function confirmDispatchSuggestion(pool, actor, id, staffId) {
  requireAdmin(actor);
  const suggestionId = idSchema.parse(id);
  const parsedStaffId = staffId == null ? undefined : idSchema.parse(staffId);
  const result = await actorTransaction(pool, actor, async (connection) => {
    const suggestion = await callProcedure(
      connection,
      "CALL sp_prepare_dispatch_suggestion(?,?)",
      [actor.id, suggestionId],
      {
        SUGGESTION_NOT_FOUND: ["调度建议不存在", "NOT_FOUND", 404],
        SUGGESTION_NOT_OPEN: ["调度建议已处理", "SUGGESTION_NOT_OPEN", 409],
      },
    );
    if (suggestion.stale) return suggestion;
    const bikeIds =
      typeof suggestion.bike_ids === "string"
        ? JSON.parse(suggestion.bike_ids)
        : suggestion.bike_ids;
    const task = await createDispatchInConnection(connection, actor, {
      source_zone_id: suggestion.source_zone_id,
      target_zone_id: suggestion.target_zone_id,
      bike_ids: bikeIds,
      staff_id: parsedStaffId,
    });
    return callProcedure(
      connection,
      "CALL sp_finish_dispatch_suggestion(?,?)",
      [suggestionId, task.id],
      {
        SUGGESTION_NOT_OPEN: ["调度建议已处理", "SUGGESTION_NOT_OPEN", 409],
      },
    );
  });
  if (result.stale)
    throw new AppError(`建议已过期：${result.stale}`, "SUGGESTION_STALE", 409);
  return result;
}

export function dismissDispatchSuggestion(pool, actor, id, input) {
  requireAdmin(actor);
  const suggestionId = idSchema.parse(id);
  const { note } = z
    .object({ note: z.string().trim().min(2).max(500) })
    .parse(input);
  return actorTransaction(pool, actor, (connection) =>
    callProcedure(
      connection,
      "CALL sp_dismiss_dispatch_suggestion(?,?,?)",
      [actor.id, suggestionId, note],
      {
        SUGGESTION_NOT_FOUND: ["调度建议不存在", "NOT_FOUND", 404],
        SUGGESTION_NOT_OPEN: ["调度建议已处理", "SUGGESTION_NOT_OPEN", 409],
      },
    ),
  );
}
