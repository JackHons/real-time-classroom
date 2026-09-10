[CmdletBinding()]
param(
  [Nullable[int]] $InterfaceIndex,
  [ValidateRange(1,65535)][int] $Port = 4173,
  [string] $RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'LanClassroomPlatform'),
  [switch] $ConfigureFirewall
)
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Import-Module (Join-Path $PSScriptRoot 'LanClassroomLauncher.psm1') -Force
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
# Establish the private root and acquire the single-instance marker before any
# port probe, firewall mutation, or user-visible URL.
$settingsPath = Initialize-LanRuntime -RuntimeRoot $runtime -RepositoryRoot $repo
$lockPath = Join-Path $runtime 'launcher.lock'
$tokenBytes = [byte[]]::new(32); $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($tokenBytes) } finally { $rng.Dispose() }
$launcherToken = [Convert]::ToBase64String($tokenBytes)
try { $lockStream = [IO.FileStream]::new($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read); $lockText = @{ token = $launcherToken; pid = $PID; startedAtUtc = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress; $lockBytes = [Text.UTF8Encoding]::new($false).GetBytes($lockText); $lockStream.Write($lockBytes, 0, $lockBytes.Length); $lockStream.Flush($true); $lockStream.Dispose() } catch { throw 'Another LAN Classroom launcher is already starting or running.' }
try { Set-PrivateRuntimeAcl -Path $lockPath } catch { Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue; throw }
$selected = Get-LanCandidateSelection -Candidates (Get-LanCandidates) -InterfaceIndex $InterfaceIndex
$addresses = @('127.0.0.1', $selected.Address)
Test-LanPortAvailable -Addresses $addresses -Port $Port
Test-LanDeployment -RepositoryRoot $repo
Test-LanSqlite -RepositoryRoot $repo -RuntimeRoot ([IO.Path]::GetFullPath($RuntimeRoot))
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
$node = (Get-Command node -ErrorAction Stop).Source
$firewall = $null
$priorOwned = $false; $priorStatePath = Join-Path ([IO.Path]::GetFullPath($RuntimeRoot)) 'launcher-state.json'
if (Test-Path -LiteralPath $priorStatePath) {
  try {
    Assert-PrivateRuntimeAcl -Path $priorStatePath
    $prior = Get-Content -LiteralPath $priorStatePath -Raw | ConvertFrom-Json
    $priorOwned = $prior.firewallOwned -eq $true -and $prior.firewallRule -eq "LanClassroom-Private-$Port" -and $prior.nodeProgram -eq $node
  } catch { throw 'Existing launcher state is invalid; stop or repair it before starting.' }
}
if ($ConfigureFirewall) {
  # A previous supervisor state is an owner-only file.  Its marker is the only
  # evidence that an otherwise identical existing rule belongs to this launcher.
  # Do not expose a listener after a requested firewall setup has failed.
  $firewall = Add-LanPrivateFirewallRule -NodeProgram $node -Port $Port -PriorOwned $priorOwned
}
$firewall = if ($null -eq $firewall -and $priorOwned) { [pscustomobject]@{ Name = [string]$prior.firewallRule; Owned = $true } } else { $firewall }
$supervisorArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'LanClassroomSupervisor.ps1'), '-RepositoryRoot', $repo, '-RuntimeRoot', ([IO.Path]::GetFullPath($RuntimeRoot)), '-NodeProgram', $node, '-Address', $selected.Address, '-Port', "$Port", '-CsrfSecret', ([string]$settings.csrfSecret), '-FirewallRule', ($(if ($null -eq $firewall) { '' } else { [string]$firewall.Name })), '-FirewallOwned', ($(if ($null -ne $firewall -and $firewall.Owned) { 'true' } else { 'false' })))
# Windows PowerShell 5.1 does not expose ProcessStartInfo.ArgumentList; use
# Start-Process so the launcher works on the supported in-box shell too.
$supervisorCommand = (($supervisorArguments | ForEach-Object { ConvertTo-LanWindowsArgument ([string]$_) }) -join ' ')
$powerShell = (Get-Command powershell -ErrorAction Stop).Source
try { $process = Start-Process -FilePath $powerShell -ArgumentList $supervisorCommand -WorkingDirectory $repo -WindowStyle Hidden -PassThru } catch { Remove-LanOwnedFirewallRule -Name $(if ($null -eq $firewall) { '' } else { $firewall.Name }) -Owned ($null -ne $firewall -and $firewall.Owned) -NodeProgram $node -Port $Port; Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue; throw }
if ($null -eq $process) { Remove-LanOwnedFirewallRule -Name $(if ($null -eq $firewall) { '' } else { $firewall.Name }) -Owned ($null -ne $firewall -and $firewall.Owned) -NodeProgram $node -Port $Port; Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue; throw 'Could not start the classroom supervisor.' }
# Start never writes launcher-state.json: the supervisor is its sole atomic
# writer and therefore cannot have a live workerPid overwritten by Start.
Write-Host "Students: http://$($selected.Address):$Port"
Write-Warning 'HTTP is only for this teacher-confirmed trusted Private LAN. It does not protect against local interception or session-token theft. Do not use Public/Domain networks or expose this port to the Internet.'
Write-Host "To stop without deleting data: .\scripts\windows\Stop-LanClassroom.ps1 -RuntimeRoot '$RuntimeRoot'"
