import { z } from "zod";
import { actorTransaction, callProcedure } from "./db.mjs";

export function updateLeaderboardProfile(pool, actor, input) {
  const data = z
    .object({
      alias: z
        .string()
        .trim()
        .min(2)
        .max(20)
        .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "昵称包含无效字符"),
      visible: z.boolean(),
    })
    .parse(input);
  return actorTransaction(pool, actor, async (connection) => {
    const row = await callProcedure(
      connection,
      "CALL sp_update_leaderboard_profile(?,?,?)",
      [actor.id, data.alias, data.visible],
    );
    return { ...row, leaderboard_visible: Boolean(row.leaderboard_visible) };
  });
}
