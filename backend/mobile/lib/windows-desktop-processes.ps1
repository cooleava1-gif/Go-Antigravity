$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $sid) { throw 'Cannot determine the current Windows user.' }
# Antigravity 2.34 stopped passing --csrf_token on the language-server command line: the token
# now only reaches the desktop renderer. Report that renderer's DevTools port alongside each row.
$debugPort = 0
$desktop = Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'Antigravity.exe' -and $_.CommandLine -match '--remote-debugging-port=\d+' } | Select-Object -First 1
if ($null -ne $desktop -and $desktop.CommandLine -match '--remote-debugging-port=(\d+)') { $debugPort = [int]$Matches[1] }
$rows = foreach ($row in Get-CimInstance Win32_Process -Filter "Name='language_server.exe'") {
    $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    if ($null -eq $owner -or $owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid) { continue }
    $listeners = Get-NetTCPConnection -State Listen -OwningProcess $row.ProcessId -ErrorAction SilentlyContinue
    [PSCustomObject]@{
        pid = $row.ProcessId
        exe = $row.ExecutablePath
        cmd = $row.CommandLine
        ports = @($listeners | Select-Object -ExpandProperty LocalPort)
        debugPort = $debugPort
    }
}
ConvertTo-Json -InputObject @($rows | Where-Object { $null -ne $_ }) -Compress -Depth 4
