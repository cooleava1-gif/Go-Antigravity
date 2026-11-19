# Run both production Windows queries against synthetic CIM rows and process handles.
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
$heldPids = [Collections.Generic.List[int]]::new()
function Invoke-CimMethod {
    param($InputObject, $MethodName, $ErrorAction)
    if ($MethodName -ne 'GetOwnerSid') { throw "Unexpected CIM method $MethodName" }
    $owner = $InputObject.Owner
    if ($InputObject.ContainsKey('OwnerAfterHandle') -and $heldPids.Contains([int]$InputObject.ProcessId)) {
        $owner = $InputObject.OwnerAfterHandle
    }
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

$stopped = [Collections.Generic.List[int]]::new()
$openedPids = [Collections.Generic.List[int]]::new()
$modulePath = $target
function Get-Process {
    param($Id, $ErrorAction)
    if ($Id -ne 11) { throw "Unexpected attempt to open PID $Id" }
    $openedPids.Add($Id)
    $fake = [pscustomobject]@{ Id = $Id; HasExited = $false }
    $fake | Add-Member ScriptProperty Handle { $heldPids.Add($this.Id); 123 }
    $fake | Add-Member ScriptProperty MainModule {
        if (-not $heldPids.Contains($this.Id)) { throw 'Identity was checked before holding a handle' }
        @{ FileName = $modulePath }
    }
    $fake | Add-Member ScriptMethod Kill { $stopped.Add($this.Id) }
    $fake | Add-Member ScriptMethod WaitForExit { param($ms) $true }
    $fake | Add-Member ScriptMethod Dispose {}
    $fake
}
$previous = $env:GOAGY_KERNEL_TARGET_PATHS
try {
    $env:GOAGY_KERNEL_TARGET_PATHS = ConvertTo-Json -InputObject @($target) -Compress
    $scriptFile = Join-Path $root 'backend/features/kernel-processes.ps1'
    if ((& $scriptFile) -ne 1 -or $stopped.Count) { throw 'Read-only query did not return just the target' }
    if ((& $scriptFile -StopTargets) -ne 1 -or ($stopped -join ',') -ne '11') { throw 'Incorrect kernel process was selected' }

    $uncTarget = '\\server\share\Portable install\resources\bin\language_server.exe'
    $pathFamilies = @(
        @{ Name = 'drive'; Paths = @($target, ('\\?\' + $target.ToUpperInvariant())) },
        @{ Name = 'UNC'; Paths = @($uncTarget, ('\\?\uNc\' + $uncTarget.Substring(2).ToUpperInvariant())) }
    )
    $aliasCases = 0
    foreach ($family in $pathFamilies) {
        foreach ($targetPath in $family.Paths) {
            foreach ($imagePath in $family.Paths) {
                foreach ($modulePath in $family.Paths) {
                    $fixtureRows = @(
                        @{ ProcessId = 11; ExecutablePath = $imagePath; Owner = $sid },
                        @{ ProcessId = 12; ExecutablePath = $imagePath; Owner = 'S-1-0-0' },
                        @{ ProcessId = 13; ExecutablePath = ($imagePath + '.other'); Owner = $sid },
                        @{ ProcessId = 14; ExecutablePath = $imagePath; Owner = $null }
                    )
                    $stopped.Clear(); $openedPids.Clear(); $heldPids.Clear()
                    $env:GOAGY_KERNEL_TARGET_PATHS = ConvertTo-Json -InputObject @('Z:\unrelated\language_server.exe', $targetPath) -Compress
                    if ((& $scriptFile) -ne 1 -or $openedPids.Count -or $stopped.Count) {
                        throw "Read-only $($family.Name) alias query crossed a path or owner boundary"
                    }
                    if ((& $scriptFile -StopTargets) -ne 1 -or ($stopped -join ',') -ne '11' -or
                        ($openedPids -join ',') -ne '11' -or ($heldPids -join ',') -ne '11') {
                        throw "Incorrect $($family.Name) alias process was selected"
                    }
                    $aliasCases++
                }
            }
        }
    }

    # A matching CIM row must still pass the identity checks after its handle is held.
    $env:GOAGY_KERNEL_TARGET_PATHS = ConvertTo-Json -InputObject @($target) -Compress
    foreach ($modulePath in @('D:\Other\Antigravity\language_server.exe', '\\server\other\language_server.exe')) {
        $fixtureRows = @(@{ ProcessId = 11; ExecutablePath = $target; Owner = $sid })
        $stopped.Clear(); $openedPids.Clear(); $heldPids.Clear()
        if ((& $scriptFile -StopTargets) -ne 1 -or $stopped.Count -or ($heldPids -join ',') -ne '11') {
            throw 'A changed process image passed the held-handle identity check'
        }
    }
    $modulePath = '\\?\' + $target
    $fixtureRows = @(@{ ProcessId = 11; ExecutablePath = $target; Owner = $sid; OwnerAfterHandle = 'S-1-0-0' })
    $stopped.Clear(); $openedPids.Clear(); $heldPids.Clear()
    if ((& $scriptFile -StopTargets) -ne 1 -or $stopped.Count -or ($heldPids -join ',') -ne '11') {
        throw 'A changed owner passed the held-handle owner check'
    }
} finally { $env:GOAGY_KERNEL_TARGET_PATHS = $previous }
Write-Host "Windows process isolation passed (mobile discovery, $aliasCases path alias combinations, held-handle identity and owner checks)"
