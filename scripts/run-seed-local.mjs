import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./seed-local.ps1", import.meta.url));
const windowsPowerShell = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const candidates = [windowsPowerShell, "pwsh.exe", "powershell.exe"];
let lastError;

for (const executable of candidates) {
  if (executable.includes("\\") && !existsSync(executable)) continue;
  const result = spawnSync(
    executable,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    { stdio: "inherit" },
  );
  if (!result.error) process.exit(result.status ?? 1);
  if (result.error.code !== "ENOENT") {
    lastError = result.error;
    break;
  }
  lastError = result.error;
}

throw new Error(
  "找不到 Windows PowerShell 或 PowerShell 7，无法启动项目 MySQL。请启用 Windows PowerShell 后重试。",
  { cause: lastError },
);
