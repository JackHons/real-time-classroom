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

function Get-LegacyWebGuiRuntimes {
  # Release packages historically kept their runtime as a sibling of the
  # extracted folder.  In this source checkout the same preserved runtime is
  # under artifacts/, so consider both *known* locations. We use only the
  # non-secret launcher state and the initialized-runtime directory shape;
  # classroom.sqlite is deliberately not inspected or used to rank candidates.
  $locations = @((Split-Path -Parent $packageRoot))
  if (Test-Path -LiteralPath (Join-Path $packageRoot 'pnpm-workspace.yaml') -PathType Leaf) { $locations += (Join-Path $packageRoot 'artifacts') }
  $result = foreach ($location in $locations | Select-Object -Unique) {
    Get-ChildItem -LiteralPath $location -Directory -Filter 'lan-classroom-local-runtime-*' -ErrorAction SilentlyContinue |
      Where-Object {
        ((Test-LanRuntimeSelectionMarker -RuntimeRoot $_.FullName) -or (Test-Path -LiteralPath (Join-Path $_.FullName 'launcher-state.json') -PathType Leaf)) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'launcher-settings.json') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'database') -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'uploads') -PathType Container)
      }
  }
  return @($result | Sort-Object FullName -Unique)
}

function Resolve-WebGuiRuntime {
  if ($runtimeWasExplicit) { return [IO.Path]::GetFullPath($RuntimeRoot) }
  $default = Join-Path $env:LOCALAPPDATA 'LanClassroomPlatform'
  # Preserve an earlier local Node 24 artifact's data when this package is
  # upgraded in place. A candidate is configured only when it has the
  # non-secret launcher-state marker plus the initialized runtime directories.
  # Never inspect classroom.sqlite (not even its size): a database file alone
  # does not prove which classroom the teacher intends to open.
  $legacy = @(Get-LegacyWebGuiRuntimes)
  $defaultConfigured = ((Test-LanRuntimeSelectionMarker -RuntimeRoot $default) -or (Test-Path -LiteralPath (Join-Path $default 'launcher-state.json') -PathType Leaf)) -and
    (Test-Path -LiteralPath (Join-Path $default 'launcher-settings.json') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $default 'database') -PathType Container) -and
    (Test-Path -LiteralPath (Join-Path $default 'uploads') -PathType Container)
  $configured = @($legacy)
  if ($defaultConfigured) { $configured += Get-Item -LiteralPath $default }
  $configured = @($configured | Sort-Object FullName -Unique)
  if ($configured.Count -eq 1) {
    Write-Host "Using existing classroom data: $($configured[0].FullName)"
    return $configured[0].FullName
  }
  if ($configured.Count -gt 1) {
    throw 'More than one configured classroom runtime was found. Refusing to choose one; start with Start-WebGui.ps1 -RuntimeRoot <the intended runtime>.'
  }
  # The workspace control is an upgrade path for this project's already
  # deployed artifact. With no state marker, a source checkout cannot safely
  # infer a configured classroom from any database file; use the conventional
  # default runtime for a genuine first run.
  # This is intentionally limited to a positively identified source checkout;
  # ordinary extracted release packages continue to use %LOCALAPPDATA%.
  return [IO.Path]::GetFullPath($default)
}

$runtime = Resolve-WebGuiRuntime

function Test-SourceCheckout {
  return (Test-Path -LiteralPath (Join-Path $packageRoot 'pnpm-workspace.yaml') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $packageRoot 'apps\server\src\main.ts') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $packageRoot 'apps\web\src') -PathType Container)
}

function Test-WorkspaceLegacyRuntime([string] $Candidate) {
  $artifactRoot = [IO.Path]::GetFullPath((Join-Path $packageRoot 'artifacts'))
  $candidatePath = [IO.Path]::GetFullPath($Candidate)
  return [IO.Path]::GetDirectoryName($candidatePath).Equals($artifactRoot, [StringComparison]::OrdinalIgnoreCase) -and
    [IO.Path]::GetFileName($candidatePath) -match '^lan-classroom-local-runtime-[A-Za-z0-9._-]+$'
}

function Build-SourceCheckout {
  # The root-level double-click control is useful to developers and testers as
  # well as to a packaged release.  Build before starting so it cannot serve a
  # stale dist/web UI after a source edit.  No runtime database or uploads are
  # touched here.
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -eq $pnpm) { throw 'This is a source checkout. pnpm is required for its one-click build; install pnpm 11+ or use the packaged release instead.' }
  Write-Host 'Building the current LAN Classroom project...'
  # SvelteKit can briefly race the previous output cleanup after a cancelled
  # build. One bounded retry handles that transient without concealing a real
  # build failure.
  foreach ($attempt in 1..2) {
    & $pnpm.Source '--dir' $packageRoot 'build'
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -eq 1) { Write-Warning 'Build did not complete; retrying once after a short cleanup delay.'; Start-Sleep -Seconds 2 }
  }
  throw 'Project build failed twice. The Web GUI was not started; correct the build error above and try again.'
}

function Get-RecordedRunningInstance {
  $statePath = Join-Path $runtime 'launcher-state.json'
  if (-not (Test-Path -LiteralPath $statePath)) { return $null }
  try {
    $state = Read-LanJsonPrivateFile -Path $statePath
    if ($null -eq $state.workerPid -or $null -eq $state.workerStartedAtUtc) { return $null }
    if ((Get-LanProcessIdentityStatus -Id ([int]$state.workerPid) -StartedAtUtc $state.workerStartedAtUtc -CommandToken 'apps/server/dist/main.js') -ne 'Running') { return $null }
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

$sourceCheckout = $false
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'release-manifest.json') -PathType Leaf)) {
  if (-not (Test-SourceCheckout)) { throw 'Deployment is incomplete: release-manifest.json is missing. Use a complete release package or a full source checkout.' }
  Build-SourceCheckout
  $sourceCheckout = $true
}

& (Join-Path $PSScriptRoot 'Start-LanClassroom.ps1') -Port $Port -RuntimeRoot $runtime -LocalOnly -SourceCheckout:$sourceCheckout
# State/lock records are intentionally removed on a clean stop. Persist only
# a non-secret selection marker for this one legacy workspace runtime, after a
# successful start, so later one-click starts retain the teacher's classroom.
if ($sourceCheckout -and (Test-WorkspaceLegacyRuntime -Candidate $runtime)) { Write-LanRuntimeSelectionMarker -RuntimeRoot $runtime }
Open-WebGui -TargetPort $Port
