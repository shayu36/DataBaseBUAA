import { z } from "zod";
import { actorTransaction } from "./db.mjs";

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
  return actorTransaction(pool, actor, async (c) => {
    await c.query(
      "UPDATE users SET leaderboard_alias=?,leaderboard_visible=? WHERE id=?",
      [data.alias, data.visible, actor.id],
    );
    await c.query(
      "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?)",
      [
        actor.id,
        "LEADERBOARD_PROFILE_UPDATE",
        "users",
        actor.id,
        JSON.stringify(data),
      ],
    );
    return { leaderboard_alias: data.alias, leaderboard_visible: data.visible };
  });
}
