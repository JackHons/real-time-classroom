Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:MinimumFreeBytes = 5 * 1GB + 2 * 100000000

function Test-PrivateIPv4 {
  param([Parameter(Mandatory)][string] $Address)
  if ($Address -match '^169\.254\.') { return $false }
  if ($Address -match '^10\.') { return $true }
  if ($Address -match '^192\.168\.') { return $true }
  return $Address -match '^172\.(1[6-9]|2[0-9]|3[01])\.'
}

function Get-LanCandidates {
  [CmdletBinding()]
  param(
    [object[]] $IpAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop),
    [object[]] $Adapters = @(Get-NetAdapter -ErrorAction Stop),
    [object[]] $Profiles = @(Get-NetConnectionProfile -ErrorAction Stop)
  )
  $adapterByIndex = @{}; foreach ($adapter in $Adapters) { $adapterByIndex[[int]$adapter.ifIndex] = $adapter }
  $profileByIndex = @{}; foreach ($profile in $Profiles) { $profileByIndex[[int]$profile.InterfaceIndex] = $profile }
  $result = foreach ($ip in $IpAddresses) {
    $index = [int]$ip.InterfaceIndex; $adapter = $adapterByIndex[$index]; $profile = $profileByIndex[$index]
    if ($null -eq $adapter -or $null -eq $profile -or $adapter.Status -ne 'Up' -or $profile.NetworkCategory -ne 'Private') { continue }
    $address = [string]$ip.IPAddress
    if (-not (Test-PrivateIPv4 $address)) { continue }
    $description = "$( $adapter.Name ) $( $adapter.InterfaceDescription )"
    [pscustomobject]@{
      InterfaceIndex = $index; Address = $address; Name = [string]$adapter.Name; Description = [string]$adapter.InterfaceDescription
      IsVirtual = $description -match '(?i)virtual|hyper-v|vmware|virtualbox|wsl|loopback|tap|tunnel|vpn'
    }
  }
  @($result | Sort-Object IsVirtual, Name, Address)
}

function Get-LanCandidateSelection {
  [CmdletBinding()]
  param([Parameter(Mandatory)][object[]] $Candidates, [Nullable[int]] $InterfaceIndex)
  if ($Candidates.Count -eq 0) { throw 'No active Private-profile private IPv4 adapter was found. Do not use a Public or Domain network.' }
  if ($null -ne $InterfaceIndex) {
    $selected = @($Candidates | Where-Object { $_.InterfaceIndex -eq $InterfaceIndex })
    if ($selected.Count -ne 1) { throw "Interface index $InterfaceIndex is not an eligible Private LAN adapter." }
    return $selected[0]
  }
  Write-Host 'Choose the Private LAN interface to expose to students:'
  for ($i = 0; $i -lt $Candidates.Count; $i += 1) {
    $virtualLabel = if ($Candidates[$i].IsVirtual) { ' [virtual adapter]' } else { '' }
    Write-Host ("  [{0}] {1} - {2} ({3}){4}" -f ($i + 1), $Candidates[$i].Address, $Candidates[$i].Name, $Candidates[$i].Description, $virtualLabel)
  }
  $choice = Read-Host 'Number'
  if ($choice -notmatch '^\d+$' -or [int]$choice -lt 1 -or [int]$choice -gt $Candidates.Count) { throw 'A listed interface must be explicitly selected.' }
  $Candidates[[int]$choice - 1]
}

function Test-LanPortAvailable {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string[]] $Addresses, [Parameter(Mandatory)][ValidateRange(1,65535)][int] $Port)
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  foreach ($address in $Addresses) {
    if ($listeners | Where-Object { $_.LocalAddress -eq $address -or $_.LocalAddress -in @('0.0.0.0', '::') }) { throw "TCP port $Port is already listening on $address (or wildcard)." }
  }
  $sockets = @()
  try {
    foreach ($address in $Addresses) { $socket = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($address), $Port); $socket.Start(); $sockets += $socket }
  } finally { foreach ($socket in $sockets) { $socket.Stop() } }
}

function Set-PrivateRuntimeAcl {
  param([Parameter(Mandatory)][string] $Path)
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.SetAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Initialize-LanRuntime {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string] $RuntimeRoot, [Parameter(Mandatory)][string] $RepositoryRoot)
  $root = [IO.Path]::GetFullPath($RuntimeRoot)
  $repo = [IO.Path]::GetFullPath($RepositoryRoot)
  Assert-LanRuntimeRoot -RuntimeRoot $root -RepositoryRoot $repo
  foreach ($directory in @($root, (Join-Path $root 'database'), (Join-Path $root 'uploads'), (Join-Path $root 'uploads\staging'), (Join-Path $root 'uploads\files'))) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
  Set-PrivateRuntimeAcl -Path $root
  $probe = Join-Path $root ('.write-probe-' + [guid]::NewGuid().ToString('N')); $stream = $null
  try { $stream = [IO.File]::Open($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, [IO.FileOptions]::WriteThrough); $stream.WriteByte(0); $stream.Flush($true) } finally { if ($null -ne $stream) { $stream.Dispose() }; Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
  $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($root).TrimEnd(':','\\'))
  if ($drive.Free -lt $script:MinimumFreeBytes) { throw "At least $script:MinimumFreeBytes bytes free space is required for runtime data and upload reserve." }
  $settings = Join-Path $root 'launcher-settings.json'
  if (-not (Test-Path -LiteralPath $settings)) {
    $bytes = [byte[]]::new(32); [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    [IO.File]::WriteAllText($settings, (@{ csrfSecret = [Convert]::ToHexString($bytes).ToLowerInvariant() } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Set-PrivateRuntimeAcl -Path $settings
  }
  $settings
}

function Test-LanDeployment {
  param([Parameter(Mandatory)][string] $RepositoryRoot)
  $required = @('apps\server\dist\main.js', 'apps\web\build\handler.js', 'apps\server\dist\db\migrations\0001_initial.sql')
  foreach ($relative in $required) { if (-not (Test-Path -LiteralPath (Join-Path $RepositoryRoot $relative) -PathType Leaf)) { throw "Deployment is incomplete: missing $relative. Run pnpm build first." } }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) { throw 'Node.js 22 or 24 LTS is required.' }
  $version = [version]((& $node.Source --version).Trim().TrimStart('v'))
  if ($version.Major -notin @(22, 24)) { throw "Node.js 22 or 24 LTS is required; found $version." }
  $sourceMigrations = @(Get-ChildItem -LiteralPath (Join-Path $RepositoryRoot 'apps\server\src\db\migrations') -Filter '*.sql')
  $builtMigrations = @(Get-ChildItem -LiteralPath (Join-Path $RepositoryRoot 'apps\server\dist\db\migrations') -Filter '*.sql')
  if ($sourceMigrations.Count -eq 0 -or $sourceMigrations.Count -ne $builtMigrations.Count) { throw 'Built SQLite migrations do not match the source migration set. Run pnpm build.' }
}

function Test-LanSqlite {
  param([Parameter(Mandatory)][string] $RepositoryRoot, [Parameter(Mandatory)][string] $RuntimeRoot)
  $node = (Get-Command node -ErrorAction Stop).Source
  $probe = Join-Path $RuntimeRoot ('.sqlite-probe-' + [guid]::NewGuid().ToString('N') + '.sqlite')
  $prior = [Environment]::GetEnvironmentVariable('LAN_CLASSROOM_SQLITE_PREFLIGHT', 'Process')
  try {
    [Environment]::SetEnvironmentVariable('LAN_CLASSROOM_SQLITE_PREFLIGHT', $probe, 'Process')
    Push-Location -LiteralPath $RepositoryRoot
    try { & $node '--input-type=module' '--eval' 'import Database from "better-sqlite3"; const db = new Database(process.env.LAN_CLASSROOM_SQLITE_PREFLIGHT); db.pragma("journal_mode = WAL"); db.close();'; if ($LASTEXITCODE -ne 0) { throw 'SQLite preflight failed.' } }
    finally { Pop-Location }
  } finally {
    [Environment]::SetEnvironmentVariable('LAN_CLASSROOM_SQLITE_PREFLIGHT', $prior, 'Process')
    Remove-Item -LiteralPath $probe, "$probe-wal", "$probe-shm" -Force -ErrorAction SilentlyContinue
  }
}

function Test-LanAdministrator { ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }

function Add-LanPrivateFirewallRule {
  param([Parameter(Mandatory)][string] $NodeProgram, [Parameter(Mandatory)][ValidateRange(1,65535)][int] $Port)
  if (-not (Test-LanAdministrator)) { throw 'Administrator rights are required to add a firewall rule.' }
  $name = "LanClassroom-Private-$Port"
  $existing = @(Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 1) { throw "More than one firewall rule is named $name. Remove the duplicate rules before starting." }
  if ($existing.Count -eq 1) {
    $rule = $existing[0]
    if (Test-LanFirewallRuleExact -Rule $rule -NodeProgram $NodeProgram -Port $Port) { return [pscustomobject]@{ Name = $name; Created = $false } }
    throw "Firewall rule $name already exists but does not match this exact Node program and TCP port. Review or remove it before starting."
  }
  New-NetFirewallRule -Name $name -DisplayName "LAN Classroom private LAN ($Port)" -Direction Inbound -Action Allow -Profile Private -Program $NodeProgram -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet | Out-Null
  [pscustomobject]@{ Name = $name; Created = $true }
}

function Assert-LanRuntimeRoot {
  param([Parameter(Mandatory)][string] $RuntimeRoot, [Parameter(Mandatory)][string] $RepositoryRoot)
  $root = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\\'); $repo = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\\')
  $rootPrefix = "$root$([IO.Path]::DirectorySeparatorChar)"; $repoPrefix = "$repo$([IO.Path]::DirectorySeparatorChar)"
  if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\\') -or $root -eq $repo -or $root.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase) -or $repo.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'RuntimeRoot must be a dedicated leaf outside, and not containing, the source checkout.' }
  foreach ($broad in @($env:LOCALAPPDATA, $env:USERPROFILE, $env:ProgramData)) { if ($null -ne $broad -and $root -eq [IO.Path]::GetFullPath($broad).TrimEnd('\\')) { throw 'RuntimeRoot must be a dedicated leaf directory, not a profile or shared parent.' } }
}

function ConvertTo-LanWindowsArgument {
  param([Parameter(Mandatory)][string] $Value)
  $builder = [Text.StringBuilder]::new(); [void]$builder.Append('"'); $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) { $slashes += 1; continue }
    if ($character -eq [char]34) { [void]$builder.Append(([string][char]92 * ($slashes * 2 + 1))); [void]$builder.Append([char]34); $slashes = 0; continue }
    if ($slashes -gt 0) { [void]$builder.Append(([string][char]92 * $slashes)); $slashes = 0 }
    [void]$builder.Append($character)
  }
  if ($slashes -gt 0) { [void]$builder.Append(([string][char]92 * ($slashes * 2))) }
  [void]$builder.Append([char]34); $builder.ToString()
}

function Write-LanLauncherState {
  param([Parameter(Mandatory)][string] $StatePath, [Parameter(Mandatory)][object] $State)
  $directory = Split-Path -Parent $StatePath; $temporary = Join-Path $directory ('.launcher-state-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText($temporary, ($State | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $StatePath) { [IO.File]::Replace($temporary, $StatePath, $null) } else { [IO.File]::Move($temporary, $StatePath) }
  } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

function Test-LanFirewallRuleExact {
  param([Parameter(Mandatory)][object] $Rule, [Parameter(Mandatory)][string] $NodeProgram, [Parameter(Mandatory)][int] $Port)
  $portFilter = @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop); $appFilter = @(Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop); $addressFilter = @(Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
  return $Rule.Enabled -eq 'True' -and $Rule.Direction -eq 'Inbound' -and $Rule.Action -eq 'Allow' -and $Rule.Profile -eq 'Private' -and $portFilter.Count -eq 1 -and $portFilter[0].Protocol -eq 'TCP' -and $portFilter[0].LocalPort -eq "$Port" -and $appFilter.Count -eq 1 -and [string]::Equals($appFilter[0].Program, $NodeProgram, [StringComparison]::OrdinalIgnoreCase) -and $addressFilter.Count -eq 1 -and $addressFilter[0].RemoteAddress -eq 'LocalSubnet'
}

function Test-LanProcessIdentity {
  param([Parameter(Mandatory)][int] $Id, [Parameter(Mandatory)][string] $StartedAtUtc, [Parameter(Mandatory)][string] $CommandToken)
  $process = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $false }
  if ([Math]::Abs(($process.StartTime.ToUniversalTime() - [DateTime]::Parse($StartedAtUtc).ToUniversalTime()).TotalSeconds) -gt 2) { return $false }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $Id" -ErrorAction SilentlyContinue
  return $null -ne $cim -and $null -ne $cim.CommandLine -and $cim.CommandLine.IndexOf($CommandToken, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Remove-LanOwnedFirewallRule { param([string] $Name, [bool] $Owned); if ($Owned -and $Name -match '^LanClassroom-Private-\d{1,5}$') { Remove-NetFirewallRule -Name $Name -ErrorAction SilentlyContinue } }

Export-ModuleMember -Function Get-LanCandidates, Get-LanCandidateSelection, Test-PrivateIPv4, Test-LanPortAvailable, Initialize-LanRuntime, Test-LanDeployment, Test-LanSqlite, Test-LanAdministrator, Add-LanPrivateFirewallRule, Assert-LanRuntimeRoot, ConvertTo-LanWindowsArgument, Write-LanLauncherState, Test-LanFirewallRuleExact, Test-LanProcessIdentity, Remove-LanOwnedFirewallRule
