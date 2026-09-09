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
$ruleName = $null
if ($ConfigureFirewall) {
  try { $ruleName = Add-LanPrivateFirewallRule -NodeProgram $node -Port $Port }
  catch { Write-Warning "Firewall rule was not changed: $($_.Exception.Message)"; Write-Warning "Ask an administrator to run: New-NetFirewallRule -Name 'LanClassroom-Private-$Port' -Direction Inbound -Action Allow -Profile Private -Program '$node' -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet" }
}
$psi = [Diagnostics.ProcessStartInfo]::new(); $psi.FileName = $node; $psi.WorkingDirectory = $repo; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
[void]$psi.ArgumentList.Add('apps/server/dist/main.js')
$psi.Environment['LAN_CLASSROOM_HOST'] = $selected.Address; $psi.Environment['LAN_CLASSROOM_HOSTS'] = ($addresses -join ','); $psi.Environment['LAN_CLASSROOM_PORT'] = "$Port"
$psi.Environment['LAN_CLASSROOM_ALLOWED_ORIGIN'] = "http://$($selected.Address):$Port"; $psi.Environment['LAN_CLASSROOM_CSRF_SECRET'] = [string]$settings.csrfSecret
$psi.Environment['LAN_CLASSROOM_DATABASE_PATH'] = Join-Path ([IO.Path]::GetFullPath($RuntimeRoot)) 'database\classroom.sqlite'; $psi.Environment['LAN_CLASSROOM_UPLOAD_STORAGE_PATH'] = Join-Path ([IO.Path]::GetFullPath($RuntimeRoot)) 'uploads'
$process = [Diagnostics.Process]::Start($psi); if ($null -eq $process) { throw 'Could not start the classroom server.' }
@{ pid = $process.Id; port = $Port; address = $selected.Address; firewallRule = $ruleName; startedAtUtc = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path ([IO.Path]::GetFullPath($RuntimeRoot)) 'launcher-state.json') -Encoding utf8
Write-Host "Students: http://$($selected.Address):$Port"
Write-Warning 'HTTP is only for this teacher-confirmed trusted Private LAN. It does not protect against local interception or session-token theft. Do not use Public/Domain networks or expose this port to the Internet.'
Write-Host "To stop without deleting data: .\scripts\windows\Stop-LanClassroom.ps1 -RuntimeRoot '$RuntimeRoot'"
