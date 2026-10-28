export async function riskData(connection, now) {
  const [result] = await connection.query("CALL sp_risk_inputs(?)", [now]);
  const [risks] = result;
  return { risks, evaluated: risks.length };
}
