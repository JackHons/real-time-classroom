Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
  if ($root.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime data must be outside the source checkout.' }
  New-Item -ItemType Directory -Force -LiteralPath $root, (Join-Path $root 'database'), (Join-Path $root 'uploads'), (Join-Path $root 'uploads\staging'), (Join-Path $root 'uploads\files') | Out-Null
  Set-PrivateRuntimeAcl -Path $root
  $probe = Join-Path $root ('.write-probe-' + [guid]::NewGuid().ToString('N')); $stream = $null
  try { $stream = [IO.File]::Open($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, [IO.FileOptions]::WriteThrough); $stream.WriteByte(0); $stream.Flush($true) } finally { if ($null -ne $stream) { $stream.Dispose() }; Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
  $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($root).TrimEnd(':','\\'))
  if ($drive.Free -lt (5GB + 200MB)) { throw 'At least 5.2 GB free space is required for runtime data and upload reserve.' }
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
  Remove-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
  New-NetFirewallRule -Name $name -DisplayName "LAN Classroom private LAN ($Port)" -Direction Inbound -Action Allow -Profile Private -Program $NodeProgram -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet | Out-Null
  $name
}

Export-ModuleMember -Function Get-LanCandidates, Get-LanCandidateSelection, Test-PrivateIPv4, Test-LanPortAvailable, Initialize-LanRuntime, Test-LanDeployment, Test-LanSqlite, Test-LanAdministrator, Add-LanPrivateFirewallRule
