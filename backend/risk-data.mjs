export async function riskData(connection, now, candidatesOnly = false) {
  const [result] = await connection.query("CALL sp_risk_inputs(?,?)", [
    now,
    candidatesOnly,
  ]);
  const [risks] = result;
  return {
    risks,
    evaluated: candidatesOnly ? result[1][0].evaluated : risks.length,
  };
}
