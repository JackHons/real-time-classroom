$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\..\scripts\windows\LanClassroomLauncher.psm1') -Force
function Assert-True([bool] $Value, [string] $Message) { if (-not $Value) { throw $Message } }
Assert-True (Test-PrivateIPv4 '10.0.0.12') '10/8 should be accepted'
Assert-True (Test-PrivateIPv4 '172.31.5.8') '172.16/12 should be accepted'
Assert-True (-not (Test-PrivateIPv4 '172.32.0.1')) 'public 172/8 must be rejected'
Assert-True (-not (Test-PrivateIPv4 '169.254.1.1')) 'APIPA must be rejected'
$adapter = [pscustomobject]@{ ifIndex = 12; Status = 'Up'; Name = 'Wi-Fi'; InterfaceDescription = 'Intel Wi-Fi' }
$virtual = [pscustomobject]@{ ifIndex = 13; Status = 'Up'; Name = 'vEthernet'; InterfaceDescription = 'Hyper-V Virtual Ethernet Adapter' }
$private = [pscustomobject]@{ InterfaceIndex = 12; IPAddress = '192.168.1.30' }
$public = [pscustomobject]@{ InterfaceIndex = 13; IPAddress = '10.0.0.30' }
$profiles = @([pscustomobject]@{ InterfaceIndex = 12; NetworkCategory = 'Private' }, [pscustomobject]@{ InterfaceIndex = 13; NetworkCategory = 'Public' })
$candidates = @(Get-LanCandidates -IpAddresses @($private, $public) -Adapters @($adapter, $virtual) -Profiles $profiles)
Assert-True ($candidates.Count -eq 1 -and $candidates[0].Address -eq '192.168.1.30') 'only active Private-profile interfaces may be listed'
Assert-True ((Get-LanCandidateSelection -Candidates $candidates -InterfaceIndex 12).Name -eq 'Wi-Fi') 'explicit interface selection failed'
$quoted = ConvertTo-LanWindowsArgument 'C:\Teacher Files\runtime\\'
Assert-True ($quoted.StartsWith([string][char]34) -and $quoted.EndsWith([string][char]34) -and $quoted.Substring($quoted.Length - 5, 4) -eq (([string][char]92) * 4)) 'trailing slash path must remain one Windows argument'
$injection = ConvertTo-LanWindowsArgument 'x" -NoProfile x'
Assert-True ($injection.Contains(([string][char]92 + [char]34))) 'embedded quote must not escape its argument'
$empty = ConvertTo-LanWindowsArgument ''
Assert-True ($empty -eq '""') 'an optional empty argument must remain one empty Windows argument'
$noCandidateMessage = $null
try { Get-LanCandidateSelection -Candidates @() | Out-Null } catch { $noCandidateMessage = $_.Exception.Message }
$expectedNoCandidate = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5om+5LiN5Yiw5ZWf55So5Lit55qE56eB5Lq657ay6LevIElQdjQg5LuL6Z2i44CC54K65a6J5YWo6LW36KaL77yM6KuL5Yu/5L2/55So5YWs55So5oiW57ay5Z+f57ay6Lev44CC'))
Assert-True ($noCandidateMessage -eq $expectedNoCandidate) 'empty candidate discovery must fail closed with the expected message'
$scratch = Join-Path $env:TEMP ('lan-launcher-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scratch) | Out-Null
try {
  $repo = Join-Path $scratch 'repo'; $runtime = Join-Path $scratch 'runtime'; [IO.Directory]::CreateDirectory($repo) | Out-Null; [IO.Directory]::CreateDirectory($runtime) | Out-Null
  Assert-True ((Assert-LanRuntimeRoot -RuntimeRoot $runtime -RepositoryRoot $repo) -eq $null) 'sibling dedicated runtime should be accepted'
  $settings = Initialize-LanRuntime -RuntimeRoot $runtime -RepositoryRoot $repo
  Assert-True (Test-Path -LiteralPath $settings -PathType Leaf) 'runtime preflight should create private launcher settings'
  Assert-True ((Assert-PrivateRuntimeAcl -Path $runtime) -eq $null) 'runtime root ACL must be verified owner-only'
  Assert-True ((Assert-PrivateRuntimeAcl -Path $settings) -eq $null) 'runtime secret ACL must be verified owner-only'
  $blocked = $false; try { Assert-LanRuntimeRoot -RuntimeRoot $scratch -RepositoryRoot $repo } catch { $blocked = $true }
  Assert-True $blocked 'a shared parent may not be used as RuntimeRoot'
  $link = Join-Path $scratch 'runtime-link'; New-Item -ItemType Junction -Path $link -Target $runtime | Out-Null
  $blocked = $false; try { Assert-LanRuntimeRoot -RuntimeRoot $link -RepositoryRoot $repo } catch { $blocked = $true }
  Assert-True $blocked 'runtime junction must be rejected before canonical containment checks'
  $statePath = Join-Path $runtime 'launcher-state.json'; Write-LanLauncherState -StatePath $statePath -State @{ supervisorPid = 1; workerPid = 2 }
  Assert-True ((Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).workerPid -eq 2) 'atomic launcher state write failed'
  Assert-True ((Assert-PrivateRuntimeAcl -Path $statePath) -eq $null) 'new launcher state ACL must be verified owner-only'
  $lockPath = Join-Path $runtime 'launcher.lock'; $first = New-LanOwnerToken
  Acquire-LanLaunchLock -LockPath $lockPath -OwnerToken $first -OwnerPid $PID -CommandToken 'launcher.tests.ps1'
  $blocked = $false; try { Acquire-LanLaunchLock -LockPath $lockPath -OwnerToken (New-LanOwnerToken) -OwnerPid $PID -CommandToken 'launcher.tests.ps1' } catch { $blocked = $true }
  Assert-True $blocked 'an active matching launcher lock must not be stolen'
  Assert-True (-not (Remove-LanLockIfOwned -LockPath $lockPath -OwnerToken 'substituted-owner')) 'a substituted owner token must not delete the active lock'
  Assert-True (Test-Path -LiteralPath $lockPath) 'failed exact-token cleanup must retain the lock'
  Assert-True (Update-LanLaunchLockOwner -LockPath $lockPath -OwnerToken $first -OwnerPid $PID -CommandToken 'launcher.tests.ps1') 'the exact owner must be able to atomically transfer its process identity'
  Remove-LanLockIfOwned -LockPath $lockPath -OwnerToken $first | Out-Null
  # A crashed starter has no state file.  Its dead, identity-shaped lock is
  # recoverable; this is intentionally different from a PID mismatch.
  $dead = @{ ownerToken = 'dead-owner'; pid = 2147483646; startedAtUtc = '2020-01-01T00:00:00.0000000Z'; commandToken = 'Start-LanClassroom.ps1' } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($lockPath, $dead, [Text.UTF8Encoding]::new($false))
  & (Get-Module LanClassroomLauncher) { param($p) Set-PrivateRuntimeAcl -Path $p } $lockPath
  $recovered = New-LanOwnerToken; Acquire-LanLaunchLock -LockPath $lockPath -OwnerToken $recovered -OwnerPid $PID -CommandToken 'launcher.tests.ps1'
  Assert-True (Test-LanLockOwned -LockPath $lockPath -OwnerToken $recovered) 'a dead stale lock without state must be recovered by its new owner'
  Remove-LanLockIfOwned -LockPath $lockPath -OwnerToken $recovered | Out-Null
  $failureLock = Join-Path $runtime 'acl-provision-failure.lock'; $provisionFailed = $false
  try { Acquire-LanLaunchLock -LockPath $failureLock -OwnerToken (New-LanOwnerToken) -OwnerPid $PID -CommandToken 'launcher.tests.ps1' -AclProvisioner { param($p) throw 'injected ACL provisioning failure' } } catch { $provisionFailed = $_.Exception.Message -match 'injected ACL provisioning failure' }
  Assert-True $provisionFailed 'ACL provisioning failure must retain its original cause'
  Assert-True (-not (Test-Path -LiteralPath $failureLock)) 'a post-create ACL failure must clean up its exact newly-created lock'
  $replacementLock = Join-Path $runtime 'acl-replacement.lock'; $replacement = 'other-process-token'; $replacementFailure = $null
  try {
    Acquire-LanLaunchLock -LockPath $replacementLock -OwnerToken (New-LanOwnerToken) -OwnerPid $PID -CommandToken 'launcher.tests.ps1' -AclProvisioner {
      param($p)
      [IO.File]::WriteAllText($p, (@{ ownerToken = $replacement; pid = 2147483646; startedAtUtc = '2020-01-01T00:00:00.0000000Z'; commandToken = 'other.ps1' } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
      throw 'injected ACL replacement failure'
    }
  } catch { $replacementFailure = $_.Exception.Message }
  Assert-True ($replacementFailure -match 'injected ACL replacement failure' -and $replacementFailure -match 'could not be safely removed') 'failed cleanup must report both provisioning and manual-recovery context'
  Assert-True ((Get-Content -LiteralPath $replacementLock -Raw | ConvertFrom-Json).ownerToken -eq $replacement) 'post-create cleanup must not delete a replacement owner lock'
  Remove-Item -LiteralPath $replacementLock -Force
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force }
function Get-NetFirewallPortFilter { @([pscustomobject]@{ Protocol = 'TCP'; LocalPort = '4173' }) }
function Get-NetFirewallApplicationFilter { @([pscustomobject]@{ Program = 'C:\Program Files\nodejs\node.exe' }) }
function Get-NetFirewallAddressFilter { @([pscustomobject]@{ RemoteAddress = 'LocalSubnet' }) }
$rule = [pscustomobject]@{ Enabled = 'True'; Direction = 'Inbound'; Action = 'Allow'; Profile = 'Private' }
Assert-True (Test-LanFirewallRuleExact -Rule $rule -NodeProgram 'C:\Program Files\nodejs\node.exe' -Port 4173) 'exact Private firewall rule should be accepted'
$rule.Enabled = 'False'; Assert-True (-not (Test-LanFirewallRuleExact -Rule $rule -NodeProgram 'C:\Program Files\nodejs\node.exe' -Port 4173)) 'disabled firewall rule must be rejected'
Assert-True (-not (Test-LanProcessIdentity -Id $PID -StartedAtUtc ([DateTime]::UtcNow.AddDays(-1).ToString('o')) -CommandToken 'launcher.tests.ps1')) 'PID reuse/start-time mismatch must not be stopped'
$stopCalled = $false
$reuseResult = Invoke-LanIdentityCheckedStop -Id $PID -StartedAtUtc ([DateTime]::UtcNow.AddDays(-1).ToString('o')) -CommandToken 'launcher.tests.ps1' -StopAction { param($process) $script:stopCalled = $true }
Assert-True ($reuseResult -eq 'Mismatch' -and -not $stopCalled) 'a stale pre-force PID snapshot must be revalidated and must not invoke the stop action'
Write-Host 'Windows launcher tests passed.'
