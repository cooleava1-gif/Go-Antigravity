$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $sid) { throw 'Cannot determine the current Windows user.' }
$rows = foreach ($row in Get-CimInstance Win32_Process -Filter "Name='language_server.exe'") {
    $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    if ($null -eq $owner -or $owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid) { continue }
    $listeners = Get-NetTCPConnection -State Listen -OwningProcess $row.ProcessId -ErrorAction SilentlyContinue
    [PSCustomObject]@{
        pid = $row.ProcessId
        exe = $row.ExecutablePath
        cmd = $row.CommandLine
        ports = @($listeners | Select-Object -ExpandProperty LocalPort)
    }
}
ConvertTo-Json -InputObject @($rows | Where-Object { $null -ne $_ }) -Compress -Depth 4
