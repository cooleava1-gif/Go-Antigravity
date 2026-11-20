# Run both production Windows queries against synthetic CIM rows.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$target = 'D:\Portable install\resources\bin\language_server.exe'
$fixtureRows = @(
    @{ ProcessId = 11; ExecutablePath = $target; Owner = $sid },
    @{ ProcessId = 12; ExecutablePath = $target; Owner = 'S-1-0-0' },
    @{ ProcessId = 13; ExecutablePath = 'D:\Other\Antigravity\language_server.exe'; Owner = $sid },
    @{ ProcessId = 14; ExecutablePath = $target; Owner = $null }
)
function Get-CimInstance { param($ClassName, $Filter) $fixtureRows }
function Invoke-CimMethod {
    param($InputObject, $MethodName, $ErrorAction)
    if ($MethodName -ne 'GetOwnerSid') { throw "Unexpected CIM method $MethodName" }
    $owner = $InputObject.Owner
    if ($owner) { [pscustomobject]@{ ReturnValue = 0; Sid = $owner } }
}
$probedPids = [Collections.Generic.List[int]]::new()
function Get-NetTCPConnection {
    param($State, $OwningProcess, $ErrorAction)
    $probedPids.Add($OwningProcess)
    [pscustomobject]@{ LocalPort = 40000 + $OwningProcess }
}
$mobile = & (Join-Path $root 'backend/mobile/lib/windows-desktop-processes.ps1') | ConvertFrom-Json
if (($mobile.pid -join ',') -ne '11,13' -or ($probedPids -join ',') -ne '11,13' -or
    $mobile[0].ports -isnot [array] -or $mobile[0].ports[0] -ne 40011) { throw 'Mobile discovery crossed an owner boundary or lost ports' }

# kernel-processes.ps1 only counts: it never opens a handle or terminates a language server, so a
# locked image is refused with an error and a clean exit is requested instead of a kill.
$previous = $env:GO_ANTIGRAVITY_KERNEL_TARGET_PATHS
try {
    $env:GO_ANTIGRAVITY_KERNEL_TARGET_PATHS = ConvertTo-Json -InputObject @($target) -Compress
    $scriptFile = Join-Path $root 'backend/features/kernel-processes.ps1'
    if ((& $scriptFile) -ne 1) { throw 'Read-only query did not return just the target' }

    $uncTarget = '\\server\share\Portable install\resources\bin\language_server.exe'
    $pathFamilies = @(
        @{ Name = 'drive'; Paths = @($target, ('\\?\' + $target.ToUpperInvariant())) },
        @{ Name = 'UNC'; Paths = @($uncTarget, ('\\?\uNc\' + $uncTarget.Substring(2).ToUpperInvariant())) }
    )
    $aliasCases = 0
    foreach ($family in $pathFamilies) {
        foreach ($targetPath in $family.Paths) {
            foreach ($imagePath in $family.Paths) {
                $fixtureRows = @(
                    @{ ProcessId = 11; ExecutablePath = $imagePath; Owner = $sid },
                    @{ ProcessId = 12; ExecutablePath = $imagePath; Owner = 'S-1-0-0' },
                    @{ ProcessId = 13; ExecutablePath = ($imagePath + '.other'); Owner = $sid },
                    @{ ProcessId = 14; ExecutablePath = $imagePath; Owner = $null }
                )
                $env:GO_ANTIGRAVITY_KERNEL_TARGET_PATHS = ConvertTo-Json -InputObject @('Z:\unrelated\language_server.exe', $targetPath) -Compress
                if ((& $scriptFile) -ne 1) {
                    throw "Read-only $($family.Name) alias query crossed a path or owner boundary"
                }
                $aliasCases++
            }
        }
    }
} finally { $env:GO_ANTIGRAVITY_KERNEL_TARGET_PATHS = $previous }
Write-Host "Windows process isolation passed (mobile discovery, $aliasCases path alias combinations, same-user exact-path counting)"
