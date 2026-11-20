# Standalone installer helper for the Go-Antigravity desktop update.
#
# This file is never downloaded. updater.py copies *this* file out of the current installation into
# a temporary folder outside the install root, then starts it with a job file. The helper waits for
# the running GUI process to exit, moves the old install root aside, moves the prepared staged
# directory into place, rolls back on any failure, and restarts the original EXE path.
#
# Account/settings data live outside the install root (see runtime.backend_data_directory); the
# helper never touches them, and the backup of the old install is kept for manual rollback.
#
# Fixtures pass -NoRestart so no executable is ever started while testing:
#   powershell -NoProfile -ExecutionPolicy Bypass -File update_install.ps1 -JobFile job.json -NoRestart
#
# Exit codes: 0 updated (or -NoRestart verified), 2 GUI still running, 3 root rename failed,
#             4 swap failed (old root restored), 5 invalid job, 6 new version did not start
#             (old root restored).
[CmdletBinding()]
param(
    [string]$JobFile = '',
    [string]$LogPath = '',
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

$script:LogPath = $LogPath
$script:ExitOk = 0
$script:ExitWaitTimeout = 2
$script:ExitRenameFailed = 3
$script:ExitSwapFailed = 4
$script:ExitBadJob = 5
$script:ExitRestartFailed = 6
$script:WaitTimeoutSeconds = 180
$script:RenameRetrySeconds = 30

function Get-ExtendedPath {
    # .NET Framework APIs need the \\?\ prefix before a path can exceed MAX_PATH.
    param([string]$Path)
    if (-not $Path) { return $Path }
    if ($Path.StartsWith('\\?\')) { return $Path }
    try { $full = [IO.Path]::GetFullPath($Path) } catch { $full = $Path }
    if ($full.StartsWith('\\')) { return '\\?\UNC\' + $full.Substring(2) }
    return '\\?\' + $full
}

function Write-UpdateLog {
    param([string]$Message, [string]$Path = $script:LogPath)
    $line = ('{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message)
    if ($Path) {
        try { Add-Content -LiteralPath $Path -Value $line -Encoding UTF8 } catch { }
    }
    Write-Host $line
}

function Test-DirectoryExists {
    param([string]$Path)
    if (-not $Path) { return $false }
    try { return [IO.Directory]::Exists((Get-ExtendedPath $Path)) } catch { return $false }
}

function Test-FileExists {
    param([string]$Path)
    if (-not $Path) { return $false }
    try { return [IO.File]::Exists((Get-ExtendedPath $Path)) } catch { return $false }
}

function Test-PathInsidePath {
    param([string]$Path, [string]$Parent)
    if (-not $Path -or -not $Parent) { return $false }
    try {
        $childFull = [IO.Path]::GetFullPath($Path).TrimEnd('\') + '\'
        $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    } catch { return $false }
    return $childFull.StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)
}

function Move-DirectorySafe {
    param([string]$Source, [string]$Destination)
    [IO.Directory]::Move((Get-ExtendedPath $Source), (Get-ExtendedPath $Destination))
}

function Wait-ForProcessExit {
    # Never terminates the GUI: it only waits for the process id recorded by updater.py.
    param([int]$TargetPid, [int]$TimeoutSeconds = $script:WaitTimeoutSeconds)
    if ($TargetPid -le 0) { return $true }
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    while ($stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        $process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
        if (-not $process) { return $true }
        try {
            if ($process.HasExited) { return $true }
        } catch {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Move-RootWithRetry {
    # The launcher, its PowerShell host and any surviving child can keep the install root busy for a
    # moment (a process whose working directory is the root blocks the rename). Retry instead of
    # killing anything.
    param([string]$Source, [string]$Destination, [int]$RetrySeconds = $script:RenameRetrySeconds)
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $attempts = 0
    $lastError = ''
    while ($true) {
        $attempts++
        try {
            Move-DirectorySafe $Source $Destination
            return $attempts
        } catch {
            $lastError = $_.Exception.Message
            if ($stopwatch.Elapsed.TotalSeconds -ge $RetrySeconds) {
                throw ('无法重命名安装目录（{0} 秒内尝试 {1} 次）：{2}' -f $RetrySeconds, $attempts, $lastError)
            }
            Start-Sleep -Milliseconds 500
        }
    }
}

function Start-InstalledLauncher {
    # Starts the EXE at the installed path with the helper's environment, minus any bundled-runtime
    # hint that points outside the freshly installed root (for example into an old backup folder).
    param([string]$Root, [string]$Launcher)
    $executable = Join-Path $Root $Launcher
    if (-not (Test-FileExists $executable)) {
        Write-UpdateLog ('restart-skipped-missing ' + $executable)
        return $false
    }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $executable
    $start.WorkingDirectory = $Root
    $start.UseShellExecute = $false
    $node = $start.EnvironmentVariables['GO_ANTIGRAVITY_NODE_EXE']
    if ($node -and -not (Test-PathInsidePath $node $Root)) {
        $start.EnvironmentVariables.Remove('GO_ANTIGRAVITY_NODE_EXE')
        Write-UpdateLog 'restart-dropped-stale-node'
    }
    $null = [Diagnostics.Process]::Start($start)
    return $true
}

function Restart-App {
    param([string]$Root, [string]$Launcher, [switch]$NoRestart)
    if ($NoRestart) {
        Write-UpdateLog 'restart-skipped-fixture'
        return
    }
    try {
        if (Start-InstalledLauncher $Root $Launcher) {
            Write-UpdateLog ('restarted ' + (Join-Path $Root $Launcher))
        }
    } catch {
        Write-UpdateLog ('restart-failed: ' + $_.Exception.Message)
    }
}

function Invoke-UpdateInstall {
    param(
        [string]$JobFile,
        [string]$LogPath = '',
        [switch]$NoRestart
    )

    $script:LogPath = $LogPath
    if (-not $JobFile) { return $script:ExitBadJob }
    if (-not $script:LogPath) {
        $script:LogPath = Join-Path (Split-Path -Parent $JobFile) 'update.log'
    }
    try {
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $script:LogPath) -Force
    } catch { }
    Write-UpdateLog ('helper-start job=' + $JobFile)

    if (-not (Test-Path -LiteralPath $JobFile -PathType Leaf)) {
        Write-UpdateLog 'job-missing'
        return $script:ExitBadJob
    }
    try {
        $job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-UpdateLog ('job-invalid: ' + $_.Exception.Message)
        return $script:ExitBadJob
    }

    $root = [string]$job.root
    $staged = [string]$job.staged
    $backup = [string]$job.backup
    $launcher = 'Go-Antigravity.exe'
    if ($job.launcher) { $launcher = [string]$job.launcher }
    $targetPid = 0
    if ($job.waitPid) { $targetPid = [int]$job.waitPid }
    $retrySeconds = $script:RenameRetrySeconds
    if ($job.retrySeconds) { $retrySeconds = [int]$job.retrySeconds }
    $waitSeconds = $script:WaitTimeoutSeconds
    if ($job.waitSeconds) { $waitSeconds = [int]$job.waitSeconds }
    $download = ''
    if ($job.download) { $download = [string]$job.download }

    if (-not $root -or -not $staged -or -not $backup) {
        Write-UpdateLog 'job-incomplete'
        return $script:ExitBadJob
    }
    $rootFull = $root.TrimEnd('\')
    $stagedFull = $staged.TrimEnd('\')
    $backupFull = $backup.TrimEnd('\')
    $parent = [IO.Path]::GetDirectoryName($rootFull)
    if (-not $parent) {
        Write-UpdateLog 'job-root-invalid'
        return $script:ExitBadJob
    }
    # The swap only ever moves siblings of the install root: same volume, nothing outside the parent
    # folder, and never the root itself.
    if ([IO.Path]::GetDirectoryName($stagedFull) -ne $parent -or
        [IO.Path]::GetDirectoryName($backupFull) -ne $parent -or
        (Test-PathInsidePath $stagedFull $rootFull) -or
        (Test-PathInsidePath $backupFull $rootFull) -or
        (Test-PathInsidePath $rootFull $backupFull)) {
        Write-UpdateLog 'job-outside-parent'
        return $script:ExitBadJob
    }
    if (-not (Test-DirectoryExists $stagedFull)) {
        Write-UpdateLog 'staged-missing'
        Restart-App $rootFull $launcher -NoRestart:$NoRestart
        return $script:ExitBadJob
    }
    if (Test-DirectoryExists $backupFull) {
        Write-UpdateLog 'backup-exists'
        Restart-App $rootFull $launcher -NoRestart:$NoRestart
        return $script:ExitBadJob
    }
    if (-not (Test-DirectoryExists $rootFull)) {
        Write-UpdateLog 'root-missing'
        return $script:ExitBadJob
    }

    Write-UpdateLog ('waiting-for-pid {0}' -f $targetPid)
    if (-not (Wait-ForProcessExit -TargetPid $targetPid -TimeoutSeconds $waitSeconds)) {
        Write-UpdateLog 'gui-still-running'
        return $script:ExitWaitTimeout
    }
    Write-UpdateLog 'gui-exited'

    try {
        $attempts = Move-RootWithRetry -Source $rootFull -Destination $backupFull -RetrySeconds $retrySeconds
        Write-UpdateLog ('root-backed-up attempts={0}' -f $attempts)
    } catch {
        Write-UpdateLog ('rename-failed: ' + $_.Exception.Message)
        Write-UpdateLog 'old-version-kept'
        Restart-App $rootFull $launcher -NoRestart:$NoRestart
        return $script:ExitRenameFailed
    }

    try {
        Move-DirectorySafe $stagedFull $rootFull
        Write-UpdateLog 'staged-activated'
    } catch {
        Write-UpdateLog ('swap-failed: ' + $_.Exception.Message)
        try {
            Move-DirectorySafe $backupFull $rootFull
            Write-UpdateLog 'rollback-restored'
        } catch {
            Write-UpdateLog ('rollback-failed: ' + $_.Exception.Message)
            Restart-App $rootFull $launcher -NoRestart:$NoRestart
            return $script:ExitSwapFailed
        }
        Restart-App $rootFull $launcher -NoRestart:$NoRestart
        return $script:ExitSwapFailed
    }

    $restartRequested = $true
    if ($job.PSObject.Properties.Name -contains 'restart') { $restartRequested = [bool]$job.restart }
    if ($NoRestart) {
        Write-UpdateLog 'restart-skipped-fixture'
    } elseif ($restartRequested) {
        $started = $false
        try {
            $started = Start-InstalledLauncher $rootFull $launcher
        } catch {
            Write-UpdateLog ('restart-failed: ' + $_.Exception.Message)
        }
        if (-not $started) {
            # Never report success for an install that will not start: put the old version back and
            # leave a clear non-zero result instead.
            Write-UpdateLog 'restart-failed-rollback-start'
            $failed = Join-Path $parent ((Split-Path -Leaf $rootFull) + '.failed-' + (Get-Date).ToString('yyyyMMdd-HHmmss'))
            try {
                Move-DirectorySafe $rootFull $failed
                Move-DirectorySafe $backupFull $rootFull
                Write-UpdateLog 'rollback-restored-after-restart-failure'
                try {
                    if (Start-InstalledLauncher $rootFull $launcher) {
                        Write-UpdateLog ('restarted ' + (Join-Path $rootFull $launcher))
                    }
                } catch {
                    Write-UpdateLog ('old-restart-failed: ' + $_.Exception.Message)
                }
                try {
                    Remove-Item -LiteralPath $failed -Recurse -Force -ErrorAction SilentlyContinue
                } catch { }
            } catch {
                Write-UpdateLog ('restart-rollback-failed: ' + $_.Exception.Message)
                try {
                    Move-DirectorySafe $failed $rootFull
                    Write-UpdateLog 'new-version-kept'
                } catch {
                    Write-UpdateLog ('keep-new-failed: ' + $_.Exception.Message)
                }
            }
            return $script:ExitRestartFailed
        }
        Write-UpdateLog ('restarted ' + (Join-Path $rootFull $launcher))
    } else {
        Write-UpdateLog 'restart-disabled'
    }

    if ($download) {
        try { Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue } catch { }
    }
    Write-UpdateLog ('update-installed version=' + [string]$job.version)
    Write-UpdateLog 'helper-done'
    return $script:ExitOk
}

if ($MyInvocation.InvocationName -ne '.') {
    $exitCode = Invoke-UpdateInstall -JobFile $JobFile -LogPath $LogPath -NoRestart:$NoRestart
    exit $exitCode
}
