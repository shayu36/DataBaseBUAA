import { createPool, ledgerTransaction } from "../server/db.mjs";
import { applyFeatureMigrations } from "../server/feature-migrations.mjs";

const pool = createPool({
  user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD,
});
try {
  if (process.env.DB_NAME !== "campus_bike")
    throw new Error("Feature migration is restricted to campus_bike.");
  const result = await ledgerTransaction(pool, applyFeatureMigrations);
  console.log(
    result.applied.length
      ? `Feature migration applied: ${result.applied.join(", ")}`
      : "Feature migration already current.",
  );
} finally {
  await pool.end();
}
