param([ValidateSet('Start','Stop')][string]$Action = 'Start')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $projectRoot '.runtime'
$dataPath = Join-Path $runtimePath 'mysql-data'
$mysqlBase = 'C:\Program Files\MySQL\MySQL Server 8.0'
if ($env:MYSQL_BASE) { $mysqlBase = $env:MYSQL_BASE }
$serverPath = Join-Path $mysqlBase 'bin\mysqld.exe'
$pidPath = Join-Path $runtimePath 'mysql.pid'
$configPath = Join-Path $runtimePath 'mysql.ini'
if ($Action -eq 'Stop') {
    if (Test-Path -LiteralPath $pidPath) {
        $serverPid = [int](Get-Content -LiteralPath $pidPath)
        $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid"
        if ($serverProcess -and $serverProcess.Name -eq 'mysqld.exe' -and $serverProcess.CommandLine.Contains($configPath)) {
            $serverHandle = Get-Process -Id $serverPid
            # mysqladmin performs a clean InnoDB shutdown; credentials stay in the project .env.
            & node (Join-Path $PSScriptRoot 'mysql-admin.mjs') shutdown
            if ($LASTEXITCODE -ne 0) { throw 'MySQL shutdown failed.' }
            # SHUTDOWN acknowledges before InnoDB finishes closing. Wait on the
            # exact process so an immediate Start cannot mistake it for ready.
            if (-not $serverHandle.WaitForExit(30000)) { throw 'MySQL is still shutting down after 30 seconds.' }
        }
    }
    exit 0
}
if (-not (Test-Path -LiteralPath $serverPath)) { throw "MySQL 8 executable not found. Set MYSQL_BASE to its installation directory." }
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
if (Test-Path -LiteralPath $pidPath) {
    $serverPid = [int](Get-Content -LiteralPath $pidPath)
    $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid"
    if ($serverProcess -and $serverProcess.Name -eq 'mysqld.exe' -and $serverProcess.CommandLine.Contains($configPath)) {
        Write-Output 'Project MySQL is already running on 127.0.0.1:3377.'
        exit 0
    }
}
if (Get-NetTCPConnection -LocalPort 3377 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 3377 is in use by another process.' }
if (-not (Test-Path -LiteralPath (Join-Path $dataPath 'mysql'))) {
    New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
    & $serverPath --no-defaults --initialize-insecure "--basedir=$mysqlBase" "--datadir=$dataPath" --console
    if ($LASTEXITCODE -ne 0) { throw 'MySQL initialization failed.' }
}
$baseSlash = $mysqlBase.Replace('\','/')
$dataSlash = $dataPath.Replace('\','/')
$pidSlash = $pidPath.Replace('\','/')
$logSlash = (Join-Path $runtimePath 'mysql-error.log').Replace('\','/')
@"
[mysqld]
basedir="$baseSlash"
datadir="$dataSlash"
port=3377
bind-address=127.0.0.1
mysqlx=0
pid-file="$pidSlash"
log-error="$logSlash"
character-set-server=utf8mb4
collation-server=utf8mb4_0900_ai_ci
default-time-zone=+00:00
innodb-buffer-pool-size=64M
max-connections=50
"@ | Set-Content -LiteralPath $configPath -Encoding ascii
Start-Process -FilePath $serverPath -ArgumentList "--defaults-file=`"$configPath`"" -WindowStyle Hidden | Out-Null
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $probe = [System.Net.Sockets.TcpClient]::new()
    try { $probe.Connect('127.0.0.1',3377); Write-Output 'Project MySQL ready on 127.0.0.1:3377.'; exit 0 }
    catch { Start-Sleep -Milliseconds 500 }
    finally { $probe.Dispose() }
}
throw 'MySQL startup timed out. Read .runtime/mysql-error.log.'
