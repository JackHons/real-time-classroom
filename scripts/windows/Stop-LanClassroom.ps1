[CmdletBinding()]
param([string] $RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'LanClassroomPlatform'))
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'LanClassroomLauncher.psm1') -Force
$statePath = Join-Path ([IO.Path]::GetFullPath($RuntimeRoot)) 'launcher-state.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host 'No launcher state was found. Runtime data was not changed.'; exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$lockPath = Join-Path ([IO.Path]::GetFullPath($RuntimeRoot)) 'launcher.lock'
$tokenValid = $false
if (Test-Path -LiteralPath $lockPath) {
  try {
    Assert-PrivateRuntimeAcl -Path $statePath; Assert-PrivateRuntimeAcl -Path $lockPath
    $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    $tokenValid = -not [string]::IsNullOrEmpty([string]$state.shutdownToken) -and $state.shutdownToken -eq $lock.token
  } catch { Write-Warning 'Launcher state or lock could not be validated; refusing graceful control and unrelated cleanup.' }
}
$workerValid = $null -ne $state.workerPid -and $null -ne $state.workerStartedAtUtc -and (Test-LanProcessIdentity -Id ([int]$state.workerPid) -StartedAtUtc ([string]$state.workerStartedAtUtc) -CommandToken 'apps/server/dist/main.js')
$supervisorValid = $null -ne $state.supervisorPid -and $null -ne $state.supervisorStartedAtUtc -and (Test-LanProcessIdentity -Id ([int]$state.supervisorPid) -StartedAtUtc ([string]$state.supervisorStartedAtUtc) -CommandToken 'LanClassroomSupervisor.ps1')
$graceful = $false
if ($tokenValid -and $workerValid) {
  try {
    $targetHost = if ([string]$state.address -match ':') { '[::1]' } else { '127.0.0.1' }
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://$targetHost`:$([int]$state.port)/internal/shutdown" -Headers @{ 'X-Lan-Shutdown-Token' = [string]$state.shutdownToken; Host = "$targetHost`:$([int]$state.port)" } -TimeoutSec 3 | Out-Null
    $until = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $until -and (Test-LanProcessIdentity -Id ([int]$state.workerPid) -StartedAtUtc ([string]$state.workerStartedAtUtc) -CommandToken 'apps/server/dist/main.js')) { Start-Sleep -Milliseconds 200 }
    $graceful = -not (Test-LanProcessIdentity -Id ([int]$state.workerPid) -StartedAtUtc ([string]$state.workerStartedAtUtc) -CommandToken 'apps/server/dist/main.js')
  } catch { Write-Warning 'Graceful shutdown IPC failed; using bounded force fallback only for the recorded processes.' }
}
if (-not $graceful -and $workerValid) { Write-Warning 'Graceful shutdown timed out; forcing the verified worker.'; Stop-Process -Id ([int]$state.workerPid) -Force }
if (-not $graceful -and $supervisorValid) { Stop-Process -Id ([int]$state.supervisorPid) -Force }
if (-not $workerValid -and $null -ne $state.workerPid) { Write-Warning 'Worker PID was reused or did not match the recorded command; it was not stopped.' }
if (-not $supervisorValid -and $null -ne $state.supervisorPid) { Write-Warning 'Supervisor PID was reused or did not match the recorded command; it was not stopped.' }
if ($tokenValid -and -not $supervisorValid) { Remove-LanOwnedFirewallRule -Name ([string]$state.firewallRule) -Owned ($state.firewallOwned -eq $true) -NodeProgram ([string]$state.nodeProgram) -Port ([int]$state.port); Remove-Item -LiteralPath $statePath -Force; Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue }
Write-Host 'Server stopped. Runtime database and uploaded files were retained.'
