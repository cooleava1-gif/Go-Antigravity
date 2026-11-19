param([switch]$StopTargets)
$ErrorActionPreference = 'Stop'
function ConvertTo-ComparisonPath {
    param([string]$Value)
    # CIM and MainModule can omit the extended-length prefix present in the target path.
    if ($Value.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
        return '\\' + $Value.Substring(8)
    }
    if ($Value.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
        return $Value.Substring(4)
    }
    return $Value
}
$paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($targetPath in (ConvertFrom-Json -InputObject $env:GOAGY_KERNEL_TARGET_PATHS)) {
    $comparisonPath = ConvertTo-ComparisonPath $targetPath
    if ($comparisonPath) { $null = $paths.Add($comparisonPath) }
}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $sid) { throw 'Cannot determine the current Windows user.' }
$count = 0
$filter = "Name='language_server.exe' OR Name='language_server_windows_x64.exe'"
foreach ($row in Get-CimInstance Win32_Process -Filter $filter) {
    $imagePath = ConvertTo-ComparisonPath $row.ExecutablePath
    if (-not $imagePath -or -not $paths.Contains($imagePath)) { continue }
    $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    if ($null -eq $owner -or $owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid) { continue }
    $count++
    if (-not $StopTargets) { continue }

    $instance = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
    if (-not $instance) { continue }
    try {
        # Hold a process handle while rechecking identity: a recycled PID cannot select a new process.
        $null = $instance.Handle
        if ($instance.HasExited) { continue }
        $modulePath = ConvertTo-ComparisonPath $instance.MainModule.FileName
        if (-not [string]::Equals($modulePath, $imagePath, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -ErrorAction SilentlyContinue
        if ($null -eq $owner -or $owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid) { continue }
        $instance.Kill()
        $null = $instance.WaitForExit(1000)
    } catch {
        if (-not $instance.HasExited) { throw }
    } finally { $instance.Dispose() }
}
$count
