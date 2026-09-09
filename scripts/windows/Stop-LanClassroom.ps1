[CmdletBinding()]
param([string] $RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'LanClassroomPlatform'))
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'LanClassroomLauncher.psm1') -Force
$statePath = Join-Path ([IO.Path]::GetFullPath($RuntimeRoot)) 'launcher-state.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host 'No launcher state was found. Runtime data was not changed.'; exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$workerValid = $null -ne $state.workerPid -and $null -ne $state.workerStartedAtUtc -and (Test-LanProcessIdentity -Id ([int]$state.workerPid) -StartedAtUtc ([string]$state.workerStartedAtUtc) -CommandToken 'apps/server/dist/main.js')
$supervisorValid = $null -ne $state.supervisorPid -and $null -ne $state.supervisorStartedAtUtc -and (Test-LanProcessIdentity -Id ([int]$state.supervisorPid) -StartedAtUtc ([string]$state.supervisorStartedAtUtc) -CommandToken 'LanClassroomSupervisor.ps1')
if ($workerValid) { Stop-Process -Id ([int]$state.workerPid) -Force }
if ($supervisorValid) { Stop-Process -Id ([int]$state.supervisorPid) -Force }
if (-not $workerValid -and $null -ne $state.workerPid) { Write-Warning 'Worker PID was reused or did not match the recorded command; it was not stopped.' }
if (-not $supervisorValid -and $null -ne $state.supervisorPid) { Write-Warning 'Supervisor PID was reused or did not match the recorded command; it was not stopped.' }
Remove-LanOwnedFirewallRule -Name ([string]$state.firewallRule) -Owned ($state.firewallOwned -eq $true)
Remove-Item -LiteralPath $statePath -Force
Write-Host 'Server stopped. Runtime database and uploaded files were retained.'
