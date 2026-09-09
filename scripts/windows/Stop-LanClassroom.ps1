[CmdletBinding()]
param([string] $RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'LanClassroomPlatform'))
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
$statePath = Join-Path ([IO.Path]::GetFullPath($RuntimeRoot)) 'launcher-state.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host 'No launcher state was found. Runtime data was not changed.'; exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
foreach ($id in @($state.workerPid, $state.pid)) {
  if ($null -eq $id) { continue }
  $process = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
  if ($null -ne $process) { Stop-Process -Id $process.Id -Force }
}
if ($state.firewallOwned -eq $true -and $null -ne $state.firewallRule -and [string]$state.firewallRule -match '^LanClassroom-Private-\d{1,5}$') { Remove-NetFirewallRule -Name ([string]$state.firewallRule) -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $statePath -Force
Write-Host 'Server stopped. Runtime database and uploaded files were retained.'
