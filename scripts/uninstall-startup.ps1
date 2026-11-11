# Removes the Viuhti Windows Startup launcher.
$startupDir = [Environment]::GetFolderPath('Startup')
$removed = $false
foreach ($name in @('Viuhti.vbs', 'TeleWeek-TV-Calendar.vbs')) {
  $vbsPath = Join-Path $startupDir $name
  if (Test-Path $vbsPath) {
    Remove-Item $vbsPath -Force
    Write-Host "Removed startup launcher: $vbsPath" -ForegroundColor Green
    $removed = $true
  }
}
if (-not $removed) {
  Write-Host "Startup launcher was not installed." -ForegroundColor Yellow
}
