# Installs a hidden Windows Startup launcher for Viuhti (no Admin/UAC needed).
$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
$startupDir = [Environment]::GetFolderPath('Startup')
$oldVbsPath = Join-Path $startupDir 'TeleWeek-TV-Calendar.vbs'
if (Test-Path $oldVbsPath) { Remove-Item $oldVbsPath -Force }
$vbsPath = Join-Path $startupDir 'Viuhti.vbs'
$cmdPath = Join-Path $projectDir 'scripts\run-hidden.cmd'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$logFile = Join-Path $projectDir 'data\server.log'

New-Item -ItemType Directory -Force (Split-Path -Parent $logFile) | Out-Null

$cmdBody = @"
@echo off
cd /d "$projectDir"
"$nodeExe" "server.js" >> "$logFile" 2>&1
"@
Set-Content -Path $cmdPath -Value $cmdBody -Encoding ASCII

$vbs = @"
CreateObject("WScript.Shell").Run """$cmdPath""", 0, False
"@
Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII

Write-Host "Installed startup launcher:" -ForegroundColor Green
Write-Host "  $vbsPath"
Write-Host "  -> $cmdPath"
Write-Host "Viuhti will now start silently in the background on Windows login."
