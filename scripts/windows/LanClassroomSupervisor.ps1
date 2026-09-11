[CmdletBinding()]
param(
  [Parameter(Mandatory)][string] $RepositoryRoot,
  [Parameter(Mandatory)][string] $RuntimeRoot,
  [Parameter(Mandatory)][string] $NodeProgram,
  [Parameter(Mandatory)][string] $Address,
  [Parameter(Mandatory)][ValidateRange(1,65535)][int] $Port,
  [string] $FirewallRule,
  [bool] $FirewallOwned
)
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
$statePath = Join-Path $RuntimeRoot 'launcher-state.json'
$lockPath = Join-Path $RuntimeRoot 'launcher.lock'
$handoffPath = Join-Path $RuntimeRoot 'supervisor-handoff.json'
Import-Module (Join-Path $PSScriptRoot 'LanClassroomLauncher.psm1') -Force
$ownsLaunch = $false; $ownerToken = $null

try {
  # Authentication is completed before this process can create a worker,
  # write state, or remove a firewall rule.  In particular, a substituted
  # handoff/lock must not grant cleanup rights over another launch.
  $handoff = Read-LanJsonPrivateFile -Path $handoffPath
  $ownerToken = [string]$handoff.ownerToken
  if ([string]::IsNullOrEmpty($ownerToken) -or -not (Test-LanLockOwned -LockPath $lockPath -OwnerToken $ownerToken)) { throw 'Supervisor handoff did not match the launcher lock.' }
  if (-not (Update-LanLaunchLockOwner -LockPath $lockPath -OwnerToken $ownerToken -OwnerPid $PID -CommandToken 'LanClassroomSupervisor.ps1')) { throw 'Supervisor could not adopt the launcher lock.' }
  # Delete only the matching handoff after the durable lock adoption.  It is no
  # longer needed and therefore cannot leak a reusable Start-to-supervisor key.
  $currentHandoff = Read-LanJsonPrivateFile -Path $handoffPath
  if ([string]$currentHandoff.ownerToken -ne $ownerToken) { throw 'Supervisor handoff changed during adoption.' }
  Remove-Item -LiteralPath $handoffPath -Force -ErrorAction Stop
  $ownsLaunch = $true
  # Read the application secret only after the owner-token handoff has been
  # authenticated and adopted.  The settings file has the same owner-only ACL
  # as the lock and is deliberately absent from process arguments.
  $settings = Read-LanJsonPrivateFile -Path (Join-Path $RuntimeRoot 'launcher-settings.json')
  $csrfSecret = [string]$settings.csrfSecret
  if ([string]::IsNullOrWhiteSpace($csrfSecret)) { throw 'Launcher settings did not contain a CSRF secret.' }
  while ($true) {
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $NodeProgram; $psi.WorkingDirectory = $RepositoryRoot; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    # ProcessStartInfo.ArgumentList is unavailable in Windows PowerShell 5.1.
    $psi.Arguments = 'apps/server/dist/main.js'
    $psi.Environment['LAN_CLASSROOM_HOST'] = $Address
    $psi.Environment['LAN_CLASSROOM_HOSTS'] = "127.0.0.1,$Address"
    $psi.Environment['LAN_CLASSROOM_PORT'] = "$Port"
    $psi.Environment['LAN_CLASSROOM_ALLOWED_ORIGIN'] = "http://$Address`:$Port"
    $psi.Environment['LAN_CLASSROOM_CSRF_SECRET'] = $csrfSecret
    $psi.Environment['LAN_CLASSROOM_DATABASE_PATH'] = Join-Path $RuntimeRoot 'database\classroom.sqlite'
    $psi.Environment['LAN_CLASSROOM_UPLOAD_STORAGE_PATH'] = Join-Path $RuntimeRoot 'uploads'
    $psi.Environment['LAN_CLASSROOM_SHUTDOWN_TOKEN'] = $ownerToken
    $worker = [Diagnostics.Process]::Start($psi)
    if ($null -eq $worker) { throw 'Could not start the classroom server.' }
    try {
      Write-LanLauncherState -StatePath $statePath -State @{ ownerToken = $ownerToken; supervisorPid = $PID; supervisorStartedAtUtc = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o'); workerPid = $worker.Id; workerStartedAtUtc = $worker.StartTime.ToUniversalTime().ToString('o'); port = $Port; address = $Address; nodeProgram = $NodeProgram; shutdownToken = $ownerToken; firewallRule = $(if ($FirewallRule) { $FirewallRule } else { $null }); firewallOwned = $FirewallOwned }
      $worker.WaitForExit()
      if ($worker.ExitCode -ne 75) { break }
    } finally {
      if ($null -ne $worker -and -not $worker.HasExited) { Stop-Process -Id $worker.Id -Force -ErrorAction SilentlyContinue; $worker.WaitForExit() }
    }
    Start-Sleep -Milliseconds 100
  }
} finally {
  if ($ownsLaunch -and -not [string]::IsNullOrEmpty($ownerToken) -and (Test-LanLockOwned -LockPath $lockPath -OwnerToken $ownerToken)) {
    Remove-LanOwnedFirewallRule -Name $FirewallRule -Owned $FirewallOwned -NodeProgram $NodeProgram -Port $Port
    if (Test-Path -LiteralPath $statePath) {
      try { $state = Read-LanJsonPrivateFile -Path $statePath; if ([string]$state.ownerToken -eq $ownerToken -and [int]$state.supervisorPid -eq $PID) { Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue } } catch { }
    }
    Remove-LanLockIfOwned -LockPath $lockPath -OwnerToken $ownerToken | Out-Null
  }
}
