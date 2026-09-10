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
  # `pnpm` launched from PowerShell 7 can pass its module search path to the
  # supported Windows PowerShell 5.1 launcher.  Load the in-box module by
  # absolute PSHOME path so Get-Acl cannot resolve the incompatible Core one.
  Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security') -Force -ErrorAction Stop
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Runtime path may not be a reparse point: $Path" }
  $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $permission = if ($item.PSIsContainer) { '(OI)(CI)F' } else { 'F' }
  & icacls.exe $Path '/inheritance:r' '/remove:g' '*S-1-1-0' '*S-1-5-11' '*S-1-5-32-545' '/grant:r' "*$($owner.Value):$permission" "*S-1-5-18:$permission" "*S-1-5-32-544:$permission" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not secure runtime ACL: $Path" }
  & icacls.exe $Path '/verify' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Runtime ACL verification failed: $Path" }
  Assert-PrivateRuntimeAcl -Path $Path
}

function Assert-PrivateRuntimeAcl {
  param([Parameter(Mandatory)][string] $Path)
  $acl = Get-Acl -LiteralPath $Path; $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544')
  if (-not $acl.AreAccessRulesProtected -or ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value -ne $owner) { throw "Runtime ACL owner or inheritance is unsafe: $Path" }
  foreach ($entry in @($acl.Access)) {
    $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($entry.IsInherited -or $entry.AccessControlType -ne 'Allow' -or $sid -notin $allowed -or (($entry.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) { throw "Runtime ACL is not owner-only: $Path" }
  }
  foreach ($sid in $allowed) { if (@($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid }).Count -eq 0) { throw "Runtime ACL is incomplete: $Path" } }
}

function Assert-PrivateRuntimeTree {
  param([Parameter(Mandatory)][string] $RuntimeRoot)
  $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($RuntimeRoot)
  while ($pending.Count -gt 0) {
    $path = $pending.Pop(); $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Runtime path may not be a reparse point: $path" }
    Set-PrivateRuntimeAcl -Path $path
    if ($item.PSIsContainer) {
      foreach ($child in @(Get-ChildItem -LiteralPath $path -Force)) { $pending.Push($child.FullName) }
    }
  }
}

function Initialize-LanRuntime {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string] $RuntimeRoot, [Parameter(Mandatory)][string] $RepositoryRoot)
  $root = [IO.Path]::GetFullPath($RuntimeRoot)
  $repo = [IO.Path]::GetFullPath($RepositoryRoot)
  Assert-LanRuntimeRoot -RuntimeRoot $root -RepositoryRoot $repo
  foreach ($directory in @($root, (Join-Path $root 'database'), (Join-Path $root 'uploads'), (Join-Path $root 'uploads\staging'), (Join-Path $root 'uploads\files'))) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
  Assert-PrivateRuntimeTree -RuntimeRoot $root
  $probe = Join-Path $root ('.write-probe-' + [guid]::NewGuid().ToString('N')); $stream = $null
  try { $stream = [IO.FileStream]::new($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough); $stream.WriteByte(0); $stream.Flush($true) } finally { if ($null -ne $stream) { $stream.Dispose() }; Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
  $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($root).TrimEnd(':','\'))
  if ($drive.Free -lt $script:MinimumFreeBytes) { throw "At least $script:MinimumFreeBytes bytes free space is required for runtime data and upload reserve." }
  $settings = Join-Path $root 'launcher-settings.json'
  if (-not (Test-Path -LiteralPath $settings)) {
    $bytes = [byte[]]::new(32); $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    [IO.File]::WriteAllText($settings, (@{ csrfSecret = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant() } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Set-PrivateRuntimeAcl -Path $settings
  }
  Assert-PrivateRuntimeTree -RuntimeRoot $root
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
  param([Parameter(Mandatory)][string] $NodeProgram, [Parameter(Mandatory)][ValidateRange(1,65535)][int] $Port, [bool] $PriorOwned = $false)
  if (-not (Test-LanAdministrator)) { throw 'Administrator rights are required to add a firewall rule.' }
  $name = "LanClassroom-Private-$Port"
  $existing = @(Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 1) { throw "More than one firewall rule is named $name. Remove the duplicate rules before starting." }
  if ($existing.Count -eq 1) {
    $rule = $existing[0]
    if (Test-LanFirewallRuleExact -Rule $rule -NodeProgram $NodeProgram -Port $Port) { return [pscustomobject]@{ Name = $name; Created = $false; Owned = $PriorOwned } }
    throw "Firewall rule $name already exists but does not match this exact Node program and TCP port. Review or remove it before starting."
  }
  New-NetFirewallRule -Name $name -DisplayName "LAN Classroom private LAN ($Port)" -Direction Inbound -Action Allow -Profile Private -Program $NodeProgram -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet | Out-Null
  [pscustomobject]@{ Name = $name; Created = $true; Owned = $true }
}

function Assert-LanRuntimeRoot {
  param([Parameter(Mandatory)][string] $RuntimeRoot, [Parameter(Mandatory)][string] $RepositoryRoot)
  $root = Get-LanCanonicalPath -Path $RuntimeRoot; $repo = Get-LanCanonicalPath -Path $RepositoryRoot
  $rootPrefix = "$root$([IO.Path]::DirectorySeparatorChar)"; $repoPrefix = "$repo$([IO.Path]::DirectorySeparatorChar)"
  if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\') -or $root -eq $repo -or $root.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase) -or $repo.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'RuntimeRoot must be a dedicated leaf outside, and not containing, the source checkout.' }
  foreach ($broad in @($env:LOCALAPPDATA, $env:USERPROFILE, $env:ProgramData)) { if ($null -ne $broad -and $root -eq [IO.Path]::GetFullPath($broad).TrimEnd('\')) { throw 'RuntimeRoot must be a dedicated leaf directory, not a profile or shared parent.' } }
  Assert-LanNoReparseAncestor -Path $RuntimeRoot
  # Both directions are checked after resolving final filesystem paths, so a
  # junction cannot make a sibling spelling alias the checkout or its parent.
  if ((Test-LanPathContains -Parent $root -Child $repo) -or (Test-LanPathContains -Parent $repo -Child $root)) { throw 'RuntimeRoot must not resolve inside, or contain, the source checkout.' }
}

function Test-LanPathContains {
  param([Parameter(Mandatory)][string] $Parent, [Parameter(Mandatory)][string] $Child)
  $parentWithSeparator = $Parent.TrimEnd('\') + '\'
  return $Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or $Child.StartsWith($parentWithSeparator, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-LanNoReparseAncestor {
  param([Parameter(Mandatory)][string] $Path)
  $candidate = [IO.Path]::GetFullPath($Path)
  while ($true) {
    if (Test-Path -LiteralPath $candidate) {
      $item = Get-Item -LiteralPath $candidate -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "RuntimeRoot may not use a junction, symlink, or other reparse point: $candidate" }
    }
    $parent = Split-Path -Parent $candidate
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $candidate) { break }
    $candidate = $parent
  }
}

function Get-LanCanonicalPath {
  param([Parameter(Mandatory)][string] $Path)
  $full = [IO.Path]::GetFullPath($Path); Assert-LanNoReparseAncestor -Path $full
  $missing = [Collections.Generic.List[string]]::new(); $existing = $full
  while (-not (Test-Path -LiteralPath $existing)) {
    $leaf = Split-Path -Leaf $existing; if ([string]::IsNullOrEmpty($leaf)) { throw "Runtime path has no existing canonical ancestor: $Path" }
    $missing.Insert(0, $leaf); $existing = Split-Path -Parent $existing
  }
  if ($null -eq ('LanClassroomNativePath' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LanClassroomNativePath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
}
'@ -ErrorAction Stop
  }
  $handle = [LanClassroomNativePath]::CreateFile($existing, [uint32]::Parse('80000000', [Globalization.NumberStyles]::HexNumber), 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
  if ($handle.IsInvalid) { throw "Could not resolve final canonical runtime path: $existing" }
  try {
    $buffer = [Text.StringBuilder]::new(32768); $length = [LanClassroomNativePath]::GetFinalPathNameByHandle($handle, $buffer, [uint32]$buffer.Capacity, 0)
    if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw "Could not resolve final canonical runtime path: $existing" }
    $canonical = $buffer.ToString(); if ($canonical.StartsWith('\\?\')) { $canonical = $canonical.Substring(4) }
  } finally { $handle.Dispose() }
  foreach ($segment in $missing) { $canonical = Join-Path $canonical $segment }
  return $canonical.TrimEnd('\')
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
    Set-PrivateRuntimeAcl -Path $StatePath
  } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

function Test-LanFirewallRuleExact {
  param([Parameter(Mandatory)][object] $Rule, [Parameter(Mandatory)][string] $NodeProgram, [Parameter(Mandatory)][int] $Port)
  $portFilter = @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop); $appFilter = @(Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop); $addressFilter = @(Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
  return $Rule.Enabled -eq 'True' -and $Rule.Direction -eq 'Inbound' -and $Rule.Action -eq 'Allow' -and $Rule.Profile -eq 'Private' -and $portFilter.Count -eq 1 -and $portFilter[0].Protocol -eq 'TCP' -and $portFilter[0].LocalPort -eq "$Port" -and $appFilter.Count -eq 1 -and [string]::Equals($appFilter[0].Program, $NodeProgram, [StringComparison]::OrdinalIgnoreCase) -and $addressFilter.Count -eq 1 -and $addressFilter[0].RemoteAddress -eq 'LocalSubnet'
}

function Test-LanProcessIdentity {
  param([Parameter(Mandatory)][int] $Id, [Parameter(Mandatory)][string] $StartedAtUtc, [Parameter(Mandatory)][string] $CommandToken)
  return (Get-LanProcessIdentityStatus -Id $Id -StartedAtUtc $StartedAtUtc -CommandToken $CommandToken) -eq 'Running'
}

function Remove-LanOwnedFirewallRule {
  param([string] $Name, [bool] $Owned, [string] $NodeProgram, [int] $Port)
  if (-not $Owned -or $Name -notmatch '^LanClassroom-Private-\d{1,5}$' -or [string]::IsNullOrEmpty($NodeProgram) -or $Port -lt 1) { return $false }
  $rules = @(Get-NetFirewallRule -Name $Name -ErrorAction SilentlyContinue)
  if ($rules.Count -ne 1 -or -not (Test-LanFirewallRuleExact -Rule $rules[0] -NodeProgram $NodeProgram -Port $Port)) { Write-Warning "Launcher-owned firewall marker was not removed because $Name no longer exactly matches its recorded rule."; return $false }
  Remove-NetFirewallRule -Name $Name -ErrorAction Stop
  return $true
}

function New-LanOwnerToken {
  $bytes = [byte[]]::new(32); $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($bytes); return [Convert]::ToBase64String($bytes) } finally { $random.Dispose() }
}

function Read-LanJsonPrivateFile {
  param([Parameter(Mandatory)][string] $Path)
  Assert-PrivateRuntimeAcl -Path $Path
  Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-LanProcessIdentityStatus {
  param([Parameter(Mandatory)][int] $Id, [Parameter(Mandatory)][string] $StartedAtUtc, [Parameter(Mandatory)][string] $CommandToken)
  $process = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if ($null -eq $process) { return 'Absent' }
  if ([Math]::Abs(($process.StartTime.ToUniversalTime() - [DateTime]::Parse($StartedAtUtc).ToUniversalTime()).TotalSeconds) -gt 2) { return 'Mismatch' }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $Id" -ErrorAction SilentlyContinue
  if ($null -eq $cim -or $null -eq $cim.CommandLine -or $cim.CommandLine.IndexOf($CommandToken, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return 'Mismatch' }
  return 'Running'
}

function Test-LanLockRecord {
  param([Parameter(Mandatory)][object] $Lock)
  return -not [string]::IsNullOrEmpty([string]$Lock.ownerToken) -and $null -ne $Lock.pid -and -not [string]::IsNullOrEmpty([string]$Lock.startedAtUtc) -and -not [string]::IsNullOrEmpty([string]$Lock.commandToken)
}

function Test-LanLockOwned {
  param([Parameter(Mandatory)][string] $LockPath, [Parameter(Mandatory)][string] $OwnerToken)
  if (-not (Test-Path -LiteralPath $LockPath)) { return $false }
  try { $lock = Read-LanJsonPrivateFile -Path $LockPath; return (Test-LanLockRecord -Lock $lock) -and [string]::Equals([string]$lock.ownerToken, $OwnerToken, [StringComparison]::Ordinal) } catch { return $false }
}

function Remove-LanLockIfOwned {
  param([Parameter(Mandatory)][string] $LockPath, [Parameter(Mandatory)][string] $OwnerToken)
  # Re-read immediately before deletion.  This is deliberately fail-closed if
  # another launcher substituted a lock after our first observation.
  if (-not (Test-LanLockOwned -LockPath $LockPath -OwnerToken $OwnerToken)) { return $false }
  Remove-Item -LiteralPath $LockPath -Force -ErrorAction Stop
  return $true
}

function Remove-LanFreshLockIfTokenMatches {
  param([Parameter(Mandatory)][string] $LockPath, [Parameter(Mandatory)][string] $OwnerToken)
  # This is only used while unwinding a CreateNew lock whose ACL setup failed.
  # ACL verification cannot be relied on in that failure mode, so compare the
  # durable token again and fail closed if the name has been substituted.
  if (-not (Test-Path -LiteralPath $LockPath)) { return $true }
  try {
    $current = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
    if (-not (Test-LanLockRecord -Lock $current) -or -not [string]::Equals([string]$current.ownerToken, $OwnerToken, [StringComparison]::Ordinal)) { return $false }
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction Stop
    return -not (Test-Path -LiteralPath $LockPath)
  } catch { return $false }
}

function Write-LanLaunchLock {
  param([Parameter(Mandatory)][string] $LockPath, [Parameter(Mandatory)][string] $OwnerToken, [Parameter(Mandatory)][int] $OwnerPid, [Parameter(Mandatory)][string] $CommandToken, [scriptblock] $AclProvisioner = { param($Path) Set-PrivateRuntimeAcl -Path $Path })
  $record = @{ ownerToken = $OwnerToken; pid = $OwnerPid; startedAtUtc = (Get-Process -Id $OwnerPid).StartTime.ToUniversalTime().ToString('o'); commandToken = $CommandToken }
  $stream = $null; $created = $false
  try {
    $stream = [IO.FileStream]::new($LockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Compress)); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
    $stream.Dispose(); $stream = $null; $created = $true
    & $AclProvisioner $LockPath
  } catch {
    $failure = $_
    if ($created) {
      if (-not (Remove-LanFreshLockIfTokenMatches -LockPath $LockPath -OwnerToken $OwnerToken)) {
        throw "Launcher lock ACL provisioning failed ($($failure.Exception.Message)); the newly-created lock at $LockPath could not be safely removed because its owner token changed or cleanup failed. Remove it manually only after confirming it is not owned by a live launcher."
      }
      $failure.Exception.Data['LanLaunchLockProvisioningFailure'] = $true
    }
    throw
  } finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Acquire-LanLaunchLock {
  param([Parameter(Mandatory)][string] $LockPath, [Parameter(Mandatory)][string] $OwnerToken, [Parameter(Mandatory)][int] $OwnerPid, [Parameter(Mandatory)][string] $CommandToken, [scriptblock] $AclProvisioner = { param($Path) Set-PrivateRuntimeAcl -Path $Path })
  for ($attempt = 0; $attempt -lt 3; $attempt += 1) {
    try { Write-LanLaunchLock -LockPath $LockPath -OwnerToken $OwnerToken -OwnerPid $OwnerPid -CommandToken $CommandToken -AclProvisioner $AclProvisioner; return }
    catch [System.IO.IOException] {
      if ($_.Exception.Data['LanLaunchLockProvisioningFailure'] -eq $true) { throw }
      # A stale lock may be recovered even when no state file was ever written,
      # but never when its owner is alive or its identity is ambiguous.
      try { $existing = Read-LanJsonPrivateFile -Path $LockPath } catch { throw 'Existing launcher lock could not be validated; refusing to replace it.' }
      if (-not (Test-LanLockRecord -Lock $existing)) { throw 'Existing launcher lock is invalid; refusing to replace it.' }
      $status = Get-LanProcessIdentityStatus -Id ([int]$existing.pid) -StartedAtUtc ([string]$existing.startedAtUtc) -CommandToken ([string]$existing.commandToken)
      if ($status -eq 'Running') { throw 'Another LAN Classroom launcher is already starting or running.' }
      if ($status -ne 'Absent') { throw 'Existing launcher lock PID was reused or did not match its command; refusing to replace it.' }
      # Check the token again before removal, so a different owner's replacement
      # is never cleaned up by stale-lock recovery.
      if (-not (Remove-LanLockIfOwned -LockPath $LockPath -OwnerToken ([string]$existing.ownerToken))) { throw 'Launcher lock changed during stale recovery; retry the start.' }
    }
  }
  throw 'Could not acquire the LAN Classroom launcher lock.'
}

function Update-LanLaunchLockOwner {
  param([Parameter(Mandatory)][string] $LockPath, [Parameter(Mandatory)][string] $OwnerToken, [Parameter(Mandatory)][int] $OwnerPid, [Parameter(Mandatory)][string] $CommandToken)
  if (-not (Test-LanLockOwned -LockPath $LockPath -OwnerToken $OwnerToken)) { return $false }
  $temporary = Join-Path (Split-Path -Parent $LockPath) ('.launcher-lock-' + [guid]::NewGuid().ToString('N') + '.tmp')
  $backup = Join-Path (Split-Path -Parent $LockPath) ('.launcher-lock-' + [guid]::NewGuid().ToString('N') + '.bak')
  try {
    $record = @{ ownerToken = $OwnerToken; pid = $OwnerPid; startedAtUtc = (Get-Process -Id $OwnerPid).StartTime.ToUniversalTime().ToString('o'); commandToken = $CommandToken }
    [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false)); Set-PrivateRuntimeAcl -Path $temporary
    if (-not (Test-LanLockOwned -LockPath $LockPath -OwnerToken $OwnerToken)) { return $false }
    [IO.File]::Replace($temporary, $LockPath, $backup); Set-PrivateRuntimeAcl -Path $LockPath; return $true
  } finally { Remove-Item -LiteralPath $temporary, $backup -Force -ErrorAction SilentlyContinue }
}

function Write-LanSupervisorHandoff {
  param([Parameter(Mandatory)][string] $Path, [Parameter(Mandatory)][string] $OwnerToken)
  [IO.File]::WriteAllText($Path, (@{ ownerToken = $OwnerToken } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false)); Set-PrivateRuntimeAcl -Path $Path
}

Export-ModuleMember -Function Get-LanCandidates, Get-LanCandidateSelection, Test-PrivateIPv4, Test-LanPortAvailable, Initialize-LanRuntime, Test-LanDeployment, Test-LanSqlite, Test-LanAdministrator, Add-LanPrivateFirewallRule, Assert-LanRuntimeRoot, Assert-PrivateRuntimeAcl, ConvertTo-LanWindowsArgument, Write-LanLauncherState, Test-LanFirewallRuleExact, Test-LanProcessIdentity, Get-LanProcessIdentityStatus, New-LanOwnerToken, Read-LanJsonPrivateFile, Test-LanLockOwned, Remove-LanLockIfOwned, Acquire-LanLaunchLock, Update-LanLaunchLockOwner, Write-LanSupervisorHandoff, Remove-LanOwnedFirewallRule
