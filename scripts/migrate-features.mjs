import { createPool, withNamedLock, withSchemaLock } from "../backend/db.mjs";
import { applyFeatureMigrationsLocked } from "../backend/feature-migrations.mjs";
import { applyProcedures } from "./sql.mjs";
import { assertMysqlVersion } from "./mysql-version.mjs";

const pool = createPool({
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
try {
  if (process.env.DB_NAME !== "campus_bike")
    throw new Error("Feature migration is restricted to campus_bike.");
  await assertMysqlVersion(pool);
  const result = await withSchemaLock(pool, (connection) =>
    withNamedLock(connection, async () => {
      const migration = await applyFeatureMigrationsLocked(connection, true);
      await applyProcedures(connection);
      return migration;
    }),
  );
  console.log(
    result.applied.length
      ? `Feature migration applied: ${result.applied.join(", ")}`
      : "Feature migration already current; SQL procedures refreshed.",
  );
} finally {
  await pool.end();
}
