[CmdletBinding()]
param([string] $RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'LanClassroomPlatform'))
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'LanClassroomLauncher.psm1') -Force
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$statePath = Join-Path $runtime 'launcher-state.json'; $lockPath = Join-Path $runtime 'launcher.lock'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host 'No launcher state was found. Runtime data was not changed.'; exit 0 }
try { $state = Read-LanJsonPrivateFile -Path $statePath } catch { Write-Warning 'Launcher state could not be validated; refusing process control and cleanup.'; exit 1 }
$ownerToken = [string]$state.ownerToken
$tokenValid = -not [string]::IsNullOrEmpty($ownerToken) -and (Test-LanLockOwned -LockPath $lockPath -OwnerToken $ownerToken)
if (-not $tokenValid) { Write-Warning 'Launcher state and lock did not have the same owner token; refusing process control and cleanup.'; exit 1 }
if ($null -eq $state.workerPid -or $null -eq $state.workerStartedAtUtc -or $null -eq $state.supervisorPid -or $null -eq $state.supervisorStartedAtUtc) { Write-Warning 'Launcher state has no complete process identities; refusing cleanup.'; exit 1 }
function Get-WorkerStatus { Get-LanProcessIdentityStatus -Id ([int]$state.workerPid) -StartedAtUtc ([string]$state.workerStartedAtUtc) -CommandToken 'apps/server/dist/main.js' }
function Get-SupervisorStatus { Get-LanProcessIdentityStatus -Id ([int]$state.supervisorPid) -StartedAtUtc ([string]$state.supervisorStartedAtUtc) -CommandToken 'LanClassroomSupervisor.ps1' }
$workerStatus = Get-WorkerStatus; $supervisorStatus = Get-SupervisorStatus; $graceful = $false
if ($workerStatus -eq 'Running') {
  try {
    $targetHost = if ([string]$state.address -match ':') { '[::1]' } else { '127.0.0.1' }
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://$targetHost`:$([int]$state.port)/internal/shutdown" -Headers @{ 'X-Lan-Shutdown-Token' = $ownerToken; Host = "$targetHost`:$([int]$state.port)" } -TimeoutSec 3 | Out-Null
    $until = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $until -and (Get-WorkerStatus) -eq 'Running') { Start-Sleep -Milliseconds 200 }
    $graceful = (Get-WorkerStatus) -eq 'Absent'
  } catch { Write-Warning 'Graceful shutdown IPC failed; using bounded force fallback only for the recorded processes.' }
}
# IPC errors and timeouts have one bounded, identity-checked force attempt.
if (-not $graceful -and $workerStatus -eq 'Running') { Write-Warning 'Graceful shutdown timed out; forcing the verified worker.'; Stop-Process -Id ([int]$state.workerPid) -Force -ErrorAction SilentlyContinue }
if (-not $graceful -and $supervisorStatus -eq 'Running') { Stop-Process -Id ([int]$state.supervisorPid) -Force -ErrorAction SilentlyContinue }
$until = [DateTime]::UtcNow.AddSeconds(5)
do { Start-Sleep -Milliseconds 100; $workerStatus = Get-WorkerStatus; $supervisorStatus = Get-SupervisorStatus } while ([DateTime]::UtcNow -lt $until -and ($workerStatus -eq 'Running' -or $supervisorStatus -eq 'Running'))
# A PID reuse/mismatched command is not treated as an exited child.  Re-read
# state and lock after the force path; only this exact owner may clean them or
# its exact firewall rule.
if ($workerStatus -ne 'Absent' -or $supervisorStatus -ne 'Absent') {
  if ($workerStatus -eq 'Mismatch') { Write-Warning 'Worker PID was reused or did not match the recorded command; it was not stopped or cleaned up.' }
  if ($supervisorStatus -eq 'Mismatch') { Write-Warning 'Supervisor PID was reused or did not match the recorded command; it was not stopped or cleaned up.' }
  Write-Warning 'Recorded launcher processes are still present; state, lock, and firewall were retained.'; exit 1
}
try { $finalState = Read-LanJsonPrivateFile -Path $statePath }
catch {
  # A graceful worker shutdown lets its verified supervisor remove both files.
  # This is the expected race, not an ownership ambiguity; only accept the
  # result once both ownership records have disappeared.
  if (-not (Test-Path -LiteralPath $statePath) -and -not (Test-Path -LiteralPath $lockPath)) { Write-Host 'Server stopped. Runtime database and uploaded files were retained.'; exit 0 }
  Write-Warning 'Launcher state changed during stop; refusing cleanup.'; exit 1
}
if ([string]$finalState.ownerToken -ne $ownerToken -or -not (Test-LanLockOwned -LockPath $lockPath -OwnerToken $ownerToken)) {
  if (-not (Test-Path -LiteralPath $statePath) -and -not (Test-Path -LiteralPath $lockPath)) { Write-Host 'Server stopped. Runtime database and uploaded files were retained.'; exit 0 }
  Write-Warning 'Launcher ownership changed during stop; refusing cleanup.'; exit 1
}
Remove-LanOwnedFirewallRule -Name ([string]$finalState.firewallRule) -Owned ($finalState.firewallOwned -eq $true) -NodeProgram ([string]$finalState.nodeProgram) -Port ([int]$finalState.port)
try { $lastState = Read-LanJsonPrivateFile -Path $statePath; if ([string]$lastState.ownerToken -ne $ownerToken) { throw 'state owner changed' }; Remove-Item -LiteralPath $statePath -Force -ErrorAction Stop } catch { Write-Warning 'Launcher state changed during cleanup; lock was retained.'; exit 1 }
Remove-LanLockIfOwned -LockPath $lockPath -OwnerToken $ownerToken | Out-Null
Write-Host 'Server stopped. Runtime database and uploaded files were retained.'
