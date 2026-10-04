@echo off
cd /d "%~dp0"
set "QINGXING_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%QINGXING_PS%" set "QINGXING_PS=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%QINGXING_PS%" (
  for /f "delims=" %%P in ('where pwsh.exe 2^>nul') do if not defined QINGXING_PS set "QINGXING_PS=%%P"
)
if not exist "%QINGXING_PS%" (
  echo Cannot find Windows PowerShell or PowerShell 7.
  echo Please enable Windows PowerShell or install PowerShell 7, then run this file again.
  pause
  exit /b 1
)
"%QINGXING_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
if errorlevel 1 pause
