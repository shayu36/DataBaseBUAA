$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $projectRoot '.runtime\app.pid'
$entryPath = Join-Path $projectRoot 'server\index.mjs'
if (Test-Path -LiteralPath $pidPath) {
    $appPid = [int](Get-Content -LiteralPath $pidPath)
    $appProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$appPid"
    if ($appProcess -and $appProcess.Name -eq 'node.exe' -and $appProcess.CommandLine.Contains($entryPath)) {
        Stop-Process -Id $appPid
        Write-Output 'Project application stopped.'
    }
}
& (Join-Path $PSScriptRoot 'mysql-local.ps1') Stop
