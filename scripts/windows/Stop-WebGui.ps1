[CmdletBinding()]
param([string] $RuntimeRoot)
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Import-Module (Join-Path $PSScriptRoot 'LanClassroomLauncher.psm1') -Force
if (-not $PSBoundParameters.ContainsKey('RuntimeRoot')) {
  $default = Join-Path $env:LOCALAPPDATA 'LanClassroomPlatform'
  $locations = @((Split-Path -Parent $packageRoot))
  if (Test-Path -LiteralPath (Join-Path $packageRoot 'pnpm-workspace.yaml') -PathType Leaf) { $locations += (Join-Path $packageRoot 'artifacts') }
  $configuredEntries = foreach ($location in $locations | Select-Object -Unique) {
    Get-ChildItem -LiteralPath $location -Directory -Filter 'lan-classroom-local-runtime-*' -ErrorAction SilentlyContinue |
      Where-Object {
        ((Test-LanRuntimeSelectionMarker -RuntimeRoot $_.FullName) -or (Test-Path -LiteralPath (Join-Path $_.FullName 'launcher-state.json') -PathType Leaf)) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'launcher-settings.json') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'database') -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'uploads') -PathType Container)
      }
  }
  if (((Test-LanRuntimeSelectionMarker -RuntimeRoot $default) -or (Test-Path -LiteralPath (Join-Path $default 'launcher-state.json') -PathType Leaf)) -and
    (Test-Path -LiteralPath (Join-Path $default 'launcher-settings.json') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $default 'database') -PathType Container) -and
    (Test-Path -LiteralPath (Join-Path $default 'uploads') -PathType Container)) {
    $configuredEntries += Get-Item -LiteralPath $default
  }
  $configured = @($configuredEntries | Sort-Object FullName -Unique)
  if ($configured.Count -eq 1) { $RuntimeRoot = $configured[0].FullName }
  elseif ($configured.Count -gt 1) { throw 'More than one configured classroom runtime was found. Refusing to choose one; run Stop-WebGui.ps1 -RuntimeRoot <the intended runtime>.' }
  else { $RuntimeRoot = $default }
}
& (Join-Path $PSScriptRoot 'Stop-LanClassroom.ps1') -RuntimeRoot $RuntimeRoot
