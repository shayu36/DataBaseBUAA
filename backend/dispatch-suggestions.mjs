import { campusDefinition } from "./campus-data.mjs";

export async function dispatchSuggestions(db, zones, demand) {
  const [result] = await db.query("CALL sp_dispatch_suggestions(?,?,?)", [
    JSON.stringify(zones),
    JSON.stringify(demand),
    campusDefinition,
  ]);
  return result[0];
}
