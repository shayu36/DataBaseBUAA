import firstCampus from "../database/campus-map-v1.json" with { type: "json" };
import previousCampus from "../database/campus-map-v2.json" with { type: "json" };
import thirdCampus from "../database/campus-map-v3.json" with { type: "json" };
import fourthCampus from "../database/campus-map-v4.json" with { type: "json" };
import fifthCampus from "../database/campus-map-v5.json" with { type: "json" };
import sixthCampus from "../database/campus-map-v6.json" with { type: "json" };
import { campusDefinition } from "./campus-data.mjs";

// The procedure executes inside the caller's locked ledger transaction.
export async function upgradeCampusMap(connection) {
  const [result] = await connection.query(
    "CALL sp_upgrade_campus_map(?,?,?,?,?,?,?)",
    [
      campusDefinition,
      JSON.stringify(firstCampus),
      JSON.stringify(previousCampus),
      JSON.stringify(thirdCampus),
      JSON.stringify(fourthCampus),
      JSON.stringify(fifthCampus),
      JSON.stringify(sixthCampus),
    ],
  );
  return Boolean(result[0][0].migrated);
}
