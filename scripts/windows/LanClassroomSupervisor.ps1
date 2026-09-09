[CmdletBinding()]
param(
  [Parameter(Mandatory)][string] $RepositoryRoot,
  [Parameter(Mandatory)][string] $RuntimeRoot,
  [Parameter(Mandatory)][string] $NodeProgram,
  [Parameter(Mandatory)][string] $Address,
  [Parameter(Mandatory)][ValidateRange(1,65535)][int] $Port,
  [Parameter(Mandatory)][string] $CsrfSecret,
  [string] $FirewallRule,
  [bool] $FirewallOwned
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$statePath = Join-Path $RuntimeRoot 'launcher-state.json'

while ($true) {
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $NodeProgram; $psi.WorkingDirectory = $RepositoryRoot; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  # ProcessStartInfo.ArgumentList is unavailable in Windows PowerShell 5.1.
  # This path is repository-relative and contains no caller-supplied text.
  $psi.Arguments = 'apps/server/dist/main.js'
  $psi.Environment['LAN_CLASSROOM_HOST'] = $Address
  $psi.Environment['LAN_CLASSROOM_HOSTS'] = "127.0.0.1,$Address"
  $psi.Environment['LAN_CLASSROOM_PORT'] = "$Port"
  $psi.Environment['LAN_CLASSROOM_ALLOWED_ORIGIN'] = "http://$Address`:$Port"
  $psi.Environment['LAN_CLASSROOM_CSRF_SECRET'] = $CsrfSecret
  $psi.Environment['LAN_CLASSROOM_DATABASE_PATH'] = Join-Path $RuntimeRoot 'database\classroom.sqlite'
  $psi.Environment['LAN_CLASSROOM_UPLOAD_STORAGE_PATH'] = Join-Path $RuntimeRoot 'uploads'
  $worker = [Diagnostics.Process]::Start($psi)
  if ($null -eq $worker) { throw 'Could not start the classroom server.' }
  @{ pid = $PID; workerPid = $worker.Id; port = $Port; address = $Address; firewallRule = $(if ($FirewallRule) { $FirewallRule } else { $null }); firewallOwned = $FirewallOwned; startedAtUtc = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
  $worker.WaitForExit()
  # Code 75 is emitted only after durable loopback first-run setup. The same
  # private runtime paths and selected interface are reused, never recreated.
  if ($worker.ExitCode -ne 75) { break }
  Start-Sleep -Milliseconds 100
}
