param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$npmExecutable = (Get-Command npm.cmd -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
    & $npmExecutable ci --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
& (Join-Path $PSScriptRoot 'mysql-local.ps1') Start
if ($LASTEXITCODE -ne 0) { throw 'MySQL startup failed.' }
& $nodeExecutable (Join-Path $PSScriptRoot 'bootstrap.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Database account setup failed.' }
& $nodeExecutable (Join-Path $PSScriptRoot 'setup.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Database schema setup failed.' }
& $nodeExecutable (Join-Path $PSScriptRoot 'migrate-features.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Feature migration failed.' }
& $nodeExecutable (Join-Path $PSScriptRoot 'seed.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Demo data setup failed.' }
& $npmExecutable run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
$runtimePath = Join-Path $projectRoot '.runtime'
$entryPath = Join-Path $projectRoot 'server\index.mjs'
$pidPath = Join-Path $runtimePath 'app.pid'
$existing = Get-NetTCPConnection -LocalPort 5188 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($existing[0].OwningProcess)"
    if (-not $existingProcess.CommandLine.Contains($entryPath)) { throw 'Port 5188 belongs to another application.' }
} else {
    $appProcess = Start-Process -FilePath $nodeExecutable -ArgumentList "`"$entryPath`"" -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'app.log') -RedirectStandardError (Join-Path $runtimePath 'app-error.log') -PassThru
    $appProcess.Id | Set-Content -LiteralPath $pidPath
}
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5188/api/health' -TimeoutSec 2
        if ($health.status -eq 'ok' -and $health.system -eq 'campus-bike') {
            Write-Output 'Qingxing is ready: http://127.0.0.1:5188'
            Write-Output 'Demo account: jia@qingxing.local / Qingxing2026!'
            if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5188' }
            exit 0
        }
    } catch { Start-Sleep -Milliseconds 500 }
}
throw 'Application startup timed out. Read .runtime/app-error.log.'
