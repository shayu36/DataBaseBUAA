import test from "node:test";
import assert from "node:assert/strict";
import { supportsMysqlVersion } from "../scripts/mysql-version.mjs";

test("MySQL version gate reflects JSON_TABLE null handling", () => {
  for (const version of ["8.0.21", "8.0.46-ubuntu", "8.4.2", "9.0.0"]) {
    assert.equal(supportsMysqlVersion(version), true, version);
  }
  for (const version of ["8.0.20", "5.7.44", "10.11.8-MariaDB", "unknown"]) {
    assert.equal(supportsMysqlVersion(version), false, version);
  }
});
