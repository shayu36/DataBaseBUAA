import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const script of ["bootstrap.mjs", "setup.mjs", "seed.mjs"]) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL(script, import.meta.url))],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("数据库初始化完成。");
