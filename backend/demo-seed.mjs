import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { findRoute } from "./analytics.mjs";
import { withNamedLock, transactionLocked } from "./db.mjs";
import { sql } from "./sql-statements.mjs";

export async function seedDemo(pool, adminPool) {
  const campus = JSON.parse(
    await readFile(
      new URL("../database/campus-map.json", import.meta.url),
      "utf8",
    ),
  );
  const seedSql = await readFile(
    new URL("../database/demo-seed.sql", import.meta.url),
    "utf8",
  );
  const name = `qingxing_seed_${randomBytes(8).toString("hex")}`;
  const distances = campus.zones.flatMap((from) =>
    campus.zones.map((to) => {
      const a = campus.nodes.find((n) => n.zone_id === from.id);
      const b = campus.nodes.find((n) => n.zone_id === to.id);
      if (!a || !b) throw new Error("Campus zone has no road node");
      return Math.round(
        findRoute(campus.nodes, campus.edges, a.id, b.id).distance_m,
      );
    }),
  );
  const hash = await bcrypt.hash("Qingxing2026!", 10);
  const admin = await adminPool.getConnection();
  try {
    return await withNamedLock(pool, async (connection, discard) => {
      let created = false,
        failed = false,
        failure;
      try {
        await admin.query(seedSql.replace("__SEED_PROCEDURE__", `\`${name}\``));
        created = true;
        return await transactionLocked(connection, discard, async (c) => {
          const [result] = await c.query(sql("call_seed_procedure"), [
            name,
            JSON.stringify(campus),
            JSON.stringify(distances),
            hash,
          ]);
          return Boolean(result[0][0].seeded);
        });
      } catch (error) {
        failed = true;
        failure = error;
        throw error;
      } finally {
        if (created) {
          try {
            await admin.query(sql("drop_temporary_procedure"), [name]);
          } catch (cleanupError) {
            if (failed)
              throw new AggregateError(
                [failure, cleanupError],
                "演示数据写入及临时过程清理均失败",
              );
            throw cleanupError;
          }
        }
      }
    });
  } finally {
    admin.release();
  }
}
