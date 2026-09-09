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
Write-Host 'Windows launcher tests passed.'
