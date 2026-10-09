$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$npmExecutable = (Get-Command npm.cmd -ErrorAction Stop).Source
$nodeVersion = [version](& $nodeExecutable -p "process.versions.node")
if ($nodeVersion -lt [version]'22.12.0') {
    throw "Node.js $nodeVersion is unsupported. Install Node.js 22.12 or newer."
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
    Write-Output 'Installing project dependencies...'
    & $npmExecutable ci --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}

& (Join-Path $PSScriptRoot 'mysql-local.ps1') Start
if ($LASTEXITCODE -ne 0) { throw 'Project MySQL startup failed.' }

$steps = @(
    @{ File = 'bootstrap.mjs'; Error = 'Database account setup failed.' },
    @{ File = 'setup.mjs'; Error = 'Database schema setup failed.' },
    @{ File = 'migrate-features.mjs'; Error = 'Feature migration failed.' },
    @{ File = 'seed.mjs'; Error = 'Demo data setup failed.' }
)
foreach ($step in $steps) {
    & $nodeExecutable (Join-Path $PSScriptRoot $step.File)
    if ($LASTEXITCODE -ne 0) { throw $step.Error }
}

Write-Output 'Database ready: campus_bike (127.0.0.1:3377).'
