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
$scratch = Join-Path $env:TEMP ('lan-launcher-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scratch) | Out-Null
try {
  $repo = Join-Path $scratch 'repo'; $runtime = Join-Path $scratch 'runtime'; [IO.Directory]::CreateDirectory($repo) | Out-Null; [IO.Directory]::CreateDirectory($runtime) | Out-Null
  Assert-True ((Assert-LanRuntimeRoot -RuntimeRoot $runtime -RepositoryRoot $repo) -eq $null) 'sibling dedicated runtime should be accepted'
  $blocked = $false; try { Assert-LanRuntimeRoot -RuntimeRoot $scratch -RepositoryRoot $repo } catch { $blocked = $true }
  Assert-True $blocked 'a shared parent may not be used as RuntimeRoot'
  $statePath = Join-Path $runtime 'launcher-state.json'; Write-LanLauncherState -StatePath $statePath -State @{ supervisorPid = 1; workerPid = 2 }
  Assert-True ((Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).workerPid -eq 2) 'atomic launcher state write failed'
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force }
function Get-NetFirewallPortFilter { @([pscustomobject]@{ Protocol = 'TCP'; LocalPort = '4173' }) }
function Get-NetFirewallApplicationFilter { @([pscustomobject]@{ Program = 'C:\Program Files\nodejs\node.exe' }) }
function Get-NetFirewallAddressFilter { @([pscustomobject]@{ RemoteAddress = 'LocalSubnet' }) }
$rule = [pscustomobject]@{ Enabled = 'True'; Direction = 'Inbound'; Action = 'Allow'; Profile = 'Private' }
Assert-True (Test-LanFirewallRuleExact -Rule $rule -NodeProgram 'C:\Program Files\nodejs\node.exe' -Port 4173) 'exact Private firewall rule should be accepted'
$rule.Enabled = 'False'; Assert-True (-not (Test-LanFirewallRuleExact -Rule $rule -NodeProgram 'C:\Program Files\nodejs\node.exe' -Port 4173)) 'disabled firewall rule must be rejected'
Assert-True (-not (Test-LanProcessIdentity -Id $PID -StartedAtUtc ([DateTime]::UtcNow.AddDays(-1).ToString('o')) -CommandToken 'launcher.tests.ps1')) 'PID reuse/start-time mismatch must not be stopped'
Write-Host 'Windows launcher tests passed.'
