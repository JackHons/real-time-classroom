[CmdletBinding()]
param(
  [Nullable[int]] $InterfaceIndex,
  [ValidateRange(1,65535)][int] $Port = 4173,
  [string] $RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'LanClassroomPlatform'),
  [switch] $ConfigureFirewall,
  # Used by the double-click Web GUI entry point.  It deliberately binds only
  # to loopback and therefore never needs, creates, or changes a firewall rule.
  [switch] $LocalOnly
)
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Import-Module (Join-Path $PSScriptRoot 'LanClassroomLauncher.psm1') -Force
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$lockPath = Join-Path $runtime 'launcher.lock'
$handoffPath = Join-Path $runtime 'supervisor-handoff.json'
$ownerToken = New-LanOwnerToken
$ownsLock = $false; $handoffWritten = $false; $firewall = $null; $node = $null

try {
  # Runtime initialization is the minimum prerequisite for an owner-only lock.
  # All later preflight, port, firewall, and process work is covered by the
  # lock and by the failure cleanup below.
  $settingsPath = Initialize-LanRuntime -RuntimeRoot $runtime -RepositoryRoot $repo
  Acquire-LanLaunchLock -LockPath $lockPath -OwnerToken $ownerToken -OwnerPid $PID -CommandToken 'Start-LanClassroom.ps1'
  $ownsLock = $true
  if ($LocalOnly -and $ConfigureFirewall) { throw 'Local-only Web GUI mode never changes Windows Firewall.' }
  # Keep an empty discovery result as an empty collection.  Passing command
  # output directly makes PowerShell treat no candidates as a missing mandatory
  # argument, which skips our deliberate Chinese fail-closed message.
  if ($LocalOnly) {
    $selected = [pscustomobject]@{ Address = '127.0.0.1' }
  } else {
    $candidates = @(Get-LanCandidates)
    $selected = Get-LanCandidateSelection -Candidates $candidates -InterfaceIndex $InterfaceIndex
  }
  $addresses = @('127.0.0.1', $selected.Address) | Select-Object -Unique
  Test-LanPortAvailable -Addresses $addresses -Port $Port
  Test-LanDeployment -RepositoryRoot $repo
  Test-LanSqlite -RepositoryRoot $repo -RuntimeRoot $runtime
  $node = (Get-Command node -ErrorAction Stop).Source
  $priorOwned = $false; $priorStatePath = Join-Path $runtime 'launcher-state.json'
  if (Test-Path -LiteralPath $priorStatePath) {
    try { $prior = Read-LanJsonPrivateFile -Path $priorStatePath; $priorOwned = $prior.firewallOwned -eq $true -and $prior.firewallRule -eq "LanClassroom-Private-$Port" -and $prior.nodeProgram -eq $node } catch { throw 'Existing launcher state is invalid; stop or repair it before starting.' }
  }
  if ($ConfigureFirewall) { $firewall = Add-LanPrivateFirewallRule -NodeProgram $node -Port $Port -PriorOwned $priorOwned }
  $firewall = if ($null -eq $firewall -and $priorOwned) { [pscustomobject]@{ Name = [string]$prior.firewallRule; Owned = $true } } else { $firewall }
  # Never put this secret on a PowerShell command line.  The supervisor reads
  # and consumes this owner-only file before touching a worker or firewall.
  Write-LanSupervisorHandoff -Path $handoffPath -OwnerToken $ownerToken; $handoffWritten = $true
  # The CSRF secret stays in launcher-settings.json, which is owner-only.  It
  # must never be included in a supervisor command line, process list, or log.
  $supervisorArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'LanClassroomSupervisor.ps1'), '-RepositoryRoot', $repo, '-RuntimeRoot', $runtime, '-NodeProgram', $node, '-Address', $selected.Address, '-Port', "$Port")
  if ($null -ne $firewall) { $supervisorArguments += @('-FirewallRule', [string]$firewall.Name, '-FirewallOwned', $(if ($firewall.Owned) { 'true' } else { 'false' })) }
  $supervisorCommand = (($supervisorArguments | ForEach-Object { ConvertTo-LanWindowsArgument ([string]$_) }) -join ' ')
  # The launcher relies on the inbox Windows PowerShell Security module for
  # owner-only ACL verification.  A bundled PowerShell Core shim can be first
  # on PATH, so select the Windows 10/11 inbox executable explicitly.
  $powerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $powerShell -PathType Leaf)) { throw 'Windows PowerShell is required to start the classroom supervisor.' }
  $supervisorStdoutLog = Initialize-LanLogFile -Path (Join-Path $runtime 'supervisor.stdout.log')
  $supervisorStderrLog = Initialize-LanLogFile -Path (Join-Path $runtime 'supervisor.stderr.log')
  $process = Start-Process -FilePath $powerShell -ArgumentList $supervisorCommand -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $supervisorStdoutLog -RedirectStandardError $supervisorStderrLog -PassThru
  if ($null -eq $process) { throw 'Could not start the classroom supervisor.' }
  # Do not let the starter disappear while the supervisor is adopting the lock.
  $until = [DateTime]::UtcNow.AddSeconds(8); $adopted = $false
  while ([DateTime]::UtcNow -lt $until) {
    if (Test-LanLockOwned -LockPath $lockPath -OwnerToken $ownerToken) {
      $lock = Read-LanJsonPrivateFile -Path $lockPath
      if ([int]$lock.pid -ne $PID) { $ownsLock = $false }
      if ([int]$lock.pid -eq $process.Id -and (Test-LanProcessIdentity -Id $process.Id -StartedAtUtc ([string]$lock.startedAtUtc) -CommandToken 'LanClassroomSupervisor.ps1')) { $adopted = $true; break }
    }
    if ($process.HasExited) { break }; Start-Sleep -Milliseconds 100
  }
  if (-not $adopted) { throw 'The classroom supervisor did not securely adopt the launcher lock.' }
  $ownsLock = $false; $handoffWritten = $false
  if ($LocalOnly) { Write-Host "Web GUI: http://127.0.0.1:$Port" }
  else {
    Write-Host "Students: http://$($selected.Address):$Port"
    Write-Warning 'HTTP is only for this teacher-confirmed trusted Private LAN. It does not protect against local interception or session-token theft. Do not use Public/Domain networks or expose this port to the Internet.'
  }
  Write-Host "To stop without deleting data: .\scripts\windows\Stop-LanClassroom.ps1 -RuntimeRoot '$RuntimeRoot'"
} catch {
  if ($ownsLock -and $null -ne $firewall) { Remove-LanOwnedFirewallRule -Name ([string]$firewall.Name) -Owned ($firewall.Owned -eq $true) -NodeProgram $node -Port $Port }
  throw
} finally {
  if ($handoffWritten -and (Test-Path -LiteralPath $handoffPath)) { try { $handoff = Read-LanJsonPrivateFile -Path $handoffPath; if ([string]$handoff.ownerToken -eq $ownerToken) { Remove-Item -LiteralPath $handoffPath -Force -ErrorAction SilentlyContinue } } catch { } }
  if ($ownsLock) { Remove-LanLockIfOwned -LockPath $lockPath -OwnerToken $ownerToken | Out-Null }
}
