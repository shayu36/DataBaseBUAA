import campus from "../database/campus-map.json" with { type: "json" };

// The procedure executes inside the caller's locked ledger transaction.
export async function upgradeCampusMap(connection) {
  const [result] = await connection.query("CALL sp_upgrade_campus_map(?)", [
    JSON.stringify(campus),
  ]);
  return Boolean(result[0][0].migrated);
}
