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
$selected = Get-LanCandidateSelection -Candidates (Get-LanCandidates) -InterfaceIndex $InterfaceIndex
$addresses = @('127.0.0.1', $selected.Address)
Test-LanPortAvailable -Addresses $addresses -Port $Port
$settingsPath = Initialize-LanRuntime -RuntimeRoot $RuntimeRoot -RepositoryRoot $repo
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
try { $process = Start-Process -FilePath $powerShell -ArgumentList $supervisorCommand -WorkingDirectory $repo -WindowStyle Hidden -PassThru } catch { Remove-LanOwnedFirewallRule -Name $(if ($null -eq $firewall) { '' } else { $firewall.Name }) -Owned ($null -ne $firewall -and $firewall.Owned) -NodeProgram $node -Port $Port; throw }
if ($null -eq $process) { Remove-LanOwnedFirewallRule -Name $(if ($null -eq $firewall) { '' } else { $firewall.Name }) -Owned ($null -ne $firewall -and $firewall.Owned) -NodeProgram $node -Port $Port; throw 'Could not start the classroom supervisor.' }
# Start never writes launcher-state.json: the supervisor is its sole atomic
# writer and therefore cannot have a live workerPid overwritten by Start.
Write-Host "Students: http://$($selected.Address):$Port"
Write-Warning 'HTTP is only for this teacher-confirmed trusted Private LAN. It does not protect against local interception or session-token theft. Do not use Public/Domain networks or expose this port to the Internet.'
Write-Host "To stop without deleting data: .\scripts\windows\Stop-LanClassroom.ps1 -RuntimeRoot '$RuntimeRoot'"
