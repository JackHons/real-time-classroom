[CmdletBinding()]
param([string] $RuntimeRoot)
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not $PSBoundParameters.ContainsKey('RuntimeRoot')) {
  $default = Join-Path $env:LOCALAPPDATA 'LanClassroomPlatform'
  if (Test-Path -LiteralPath (Join-Path $default 'launcher-state.json') -PathType Leaf) { $RuntimeRoot = $default }
  else {
    $legacy = @(Get-ChildItem -LiteralPath (Split-Path -Parent $packageRoot) -Directory -Filter 'lan-classroom-local-runtime-*' -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'launcher-state.json') -PathType Leaf })
    if ($legacy.Count -eq 1) { $RuntimeRoot = $legacy[0].FullName } else { $RuntimeRoot = $default }
  }
}
& (Join-Path $PSScriptRoot 'Stop-LanClassroom.ps1') -RuntimeRoot $RuntimeRoot
