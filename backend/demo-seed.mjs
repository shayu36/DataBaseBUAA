import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { findRoute } from "./analytics.mjs";
import { withSchemaLock, ledgerTransaction } from "./db.mjs";
import { sql } from "./sql-statements.mjs";
import { campus, campusDefinition } from "./campus-data.mjs";

export async function seedDemo(pool, adminPool) {
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
  const result = await executeSeed(
    pool,
    adminPool,
    "demo-seed.sql",
    "call_seed_procedure",
    [campusDefinition, JSON.stringify(distances), hash],
  );
  return Boolean(result.seeded);
}

export async function seedSimulation(pool, adminPool) {
  const [users, bikes] = await Promise.all([
    readFile(
      new URL("../database/simulation/users.json", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../database/simulation/bikes.json", import.meta.url),
      "utf8",
    ),
  ]);
  const hash = await bcrypt.hash("Qingxing2026!", 10);
  return executeSeed(
    pool,
    adminPool,
    "simulation-seed.sql",
    "call_simulation_procedure",
    [users, bikes, hash, campusDefinition],
  );
}

async function executeSeed(pool, adminPool, filename, statement, params) {
  const seedSql = await readFile(
    new URL(`../database/${filename}`, import.meta.url),
    "utf8",
  );
  const name = `qingxing_seed_${randomBytes(8).toString("hex")}`;
  return withSchemaLock(adminPool, async (admin) => {
    let created = false,
      failed = false,
      failure;
    try {
      await admin.query(seedSql.replace("__SEED_PROCEDURE__", `\`${name}\``));
      created = true;
      return await ledgerTransaction(pool, async (connection) => {
        const [result] = await connection.query(sql(statement), [
          name,
          ...params,
        ]);
        return result[0][0];
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
}
