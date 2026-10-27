export async function dispatchSuggestions(db, zones, demand) {
  const [result] = await db.query("CALL sp_dispatch_suggestions(?,?)", [
    JSON.stringify(zones),
    JSON.stringify(demand),
  ]);
  return result[0];
}
