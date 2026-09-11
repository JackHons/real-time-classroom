[CmdletBinding()]
param(
  [ValidateRange(1,65535)][int] $Port = 50165,
  [string] $RuntimeRoot
)
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
$modulePath = Join-Path $PSScriptRoot 'LanClassroomLauncher.psm1'
Import-Module $modulePath -Force
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtimeWasExplicit = $PSBoundParameters.ContainsKey('RuntimeRoot')

function Resolve-WebGuiRuntime {
  if ($runtimeWasExplicit) { return [IO.Path]::GetFullPath($RuntimeRoot) }
  $default = Join-Path $env:LOCALAPPDATA 'LanClassroomPlatform'
  # Preserve an earlier local Node 24 artifact's data when this package is
  # upgraded in place.  Selection is by a unique sibling runtime containing a
  # database file only; no account, password hash, or other database content is
  # read.  A current default runtime always takes precedence once it has data.
  if (Test-Path -LiteralPath (Join-Path $default 'database\classroom.sqlite') -PathType Leaf) { return [IO.Path]::GetFullPath($default) }
  $legacy = @(Get-ChildItem -LiteralPath (Split-Path -Parent $packageRoot) -Directory -Filter 'lan-classroom-local-runtime-*' -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'database\classroom.sqlite') -PathType Leaf })
  if ($legacy.Count -eq 1) { Write-Host "Using existing classroom data: $($legacy[0].FullName)"; return $legacy[0].FullName }
  return [IO.Path]::GetFullPath($default)
}

$runtime = Resolve-WebGuiRuntime

function Get-RecordedRunningInstance {
  $statePath = Join-Path $runtime 'launcher-state.json'
  if (-not (Test-Path -LiteralPath $statePath)) { return $null }
  try {
    $state = Read-LanJsonPrivateFile -Path $statePath
    if ($null -eq $state.workerPid -or $null -eq $state.workerStartedAtUtc) { return $null }
    if ((Get-LanProcessIdentityStatus -Id ([int]$state.workerPid) -StartedAtUtc ([string]$state.workerStartedAtUtc) -CommandToken 'apps/server/dist/main.js') -ne 'Running') { return $null }
    return $state
  } catch { return $null }
}

function Get-HealthStatus([int] $TargetPort) {
  try { return [int](Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$TargetPort/health" -TimeoutSec 2).StatusCode }
  catch { if ($null -ne $_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }; return $null }
}

function Open-WebGui([int] $TargetPort) {
  $status = $null
  foreach ($attempt in 1..120) {
    $status = Get-HealthStatus -TargetPort $TargetPort
    if ($null -ne $status) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($null -eq $status) { throw "The Web GUI did not become ready. See $runtime\server.stderr.log" }
  $suffix = if ($status -eq 503) { '/setup' } else { '/' }
  $url = "http://127.0.0.1:$TargetPort$suffix"
  Start-Process $url
  Write-Host "Web GUI is ready: $url"
}

$running = Get-RecordedRunningInstance
if ($null -ne $running) {
  $runningPort = [int]$running.port
  if ($runningPort -ne $Port) { Write-Host "LAN Classroom is already running on http://127.0.0.1:$runningPort. Opening the existing instance." }
  else { Write-Host 'LAN Classroom Web GUI is already running. Opening it.' }
  Open-WebGui -TargetPort $runningPort
  exit 0
}

& (Join-Path $PSScriptRoot 'Start-LanClassroom.ps1') -Port $Port -RuntimeRoot $runtime -LocalOnly
Open-WebGui -TargetPort $Port
