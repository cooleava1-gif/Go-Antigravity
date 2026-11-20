# Installer helper regressions for the Go-Antigravity desktop update.
# Real directory swaps run inside a temporary fixture: no real install, no real release asset and
# no launcher process is ever started (fixture mode passes -NoRestart).
$ErrorActionPreference = 'Stop'

$script:repoRoot = Split-Path -Parent $PSScriptRoot
$script:helperSource = Join-Path $script:repoRoot 'desktop-qt/update_install.ps1'
$script:powershell = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
$script:base = Join-Path ([IO.Path]::GetTempPath()) ('go-antigravity-update-test-' + [guid]::NewGuid().ToString('N'))
$script:work = Join-Path $script:base 'helper'
$script:helper = Join-Path $script:work 'update_install.ps1'
$script:passed = 0
$script:children = New-Object System.Collections.Generic.List[object]

function Test-Case([string]$Name, [scriptblock]$Body) {
    & $Body
    $script:passed++
    Write-Host ("PASS $Name")
}

function Assert-True($Value, [string]$Message) {
    if (-not $Value) { throw $Message }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
    if ($Expected -ne $Actual) { throw ("{0} (expected '{1}', got '{2}')" -f $Message, $Expected, $Actual) }
}

function Assert-Contains([string]$Text, [string]$Needle, [string]$Message) {
    if (-not $Text.Contains($Needle)) { throw ("{0} (missing '{1}' in log: {2})" -f $Message, $Needle, $Text) }
}

function Get-LogText([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8)
}

function Get-Marker([string]$Root) {
    return (Get-Content -LiteralPath (Join-Path $Root 'marker.txt') -Raw).Trim()
}

function New-Fixture {
    # Root, staged and backup names deliberately contain Chinese characters and spaces so the
    # extended-path handling is exercised the same way a real user profile would exercise it.
    param([string]$Name)
    $parent = Join-Path $script:base $Name
    $null = New-Item -ItemType Directory -Path $parent -Force
    $rootName = 'Go-Antigravity 安装 目录'
    $root = Join-Path $parent $rootName
    $null = New-Item -ItemType Directory -Path $root
    Set-Content -LiteralPath (Join-Path $root 'marker.txt') -Value 'old'
    Set-Content -LiteralPath (Join-Path $root 'Go-Antigravity.exe') -Value 'synthetic launcher placeholder'
    $null = New-Item -ItemType Directory -Path (Join-Path $root 'runtime')
    Set-Content -LiteralPath (Join-Path $root 'runtime/manifest.json') -Value '{"package":"Go-Antigravity","platform":"windows-x64","version":"1.0.0"}'
    $staged = Join-Path $parent ('.' + $rootName + '.update-' + $Name)
    $null = New-Item -ItemType Directory -Path $staged
    Set-Content -LiteralPath (Join-Path $staged 'marker.txt') -Value 'new'
    $null = New-Item -ItemType Directory -Path (Join-Path $staged 'runtime')
    Set-Content -LiteralPath (Join-Path $staged 'runtime/manifest.json') -Value '{"package":"Go-Antigravity","platform":"windows-x64","version":"1.1.0"}'
    $backup = Join-Path $parent ($rootName + '.backup-' + $Name)
    return [pscustomobject]@{
        Parent = $parent
        Root = $root
        Staged = $staged
        Backup = $backup
        Log = (Join-Path $parent 'update.log')
        Download = (Join-Path $parent 'asset.zip')
        Job = (Join-Path $parent 'job.json')
    }
}

function New-Job {
    param(
        [pscustomobject]$Fixture,
        [int]$WaitPid = 0,
        [int]$RetrySeconds = 5,
        [int]$WaitSeconds = 60,
        [string]$Launcher = 'Go-Antigravity.exe',
        [bool]$Restart = $true
    )
    $job = [ordered]@{
        root = $Fixture.Root
        staged = $Fixture.Staged
        backup = $Fixture.Backup
        launcher = $Launcher
        version = '1.1.0'
        waitPid = $WaitPid
        retrySeconds = $RetrySeconds
        waitSeconds = $WaitSeconds
        restart = $Restart
        download = $Fixture.Download
        logPath = $Fixture.Log
    }
    $json = $job | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($Fixture.Job, $json, (New-Object Text.UTF8Encoding($true)))
    return $Fixture.Job
}

function Invoke-Helper {
    param([string]$JobFile, [string]$LogPath, [switch]$NoRestart)
    $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                   '-File', $script:helper, '-JobFile', $JobFile, '-LogPath', $LogPath)
    if ($NoRestart) { $arguments += '-NoRestart' }
    & $script:powershell @arguments | Out-Null
    return $LASTEXITCODE
}

function Start-Child {
    param([string[]]$Arguments, [string]$WorkingDirectory = '')
    if ($WorkingDirectory) {
        $process = Start-Process -FilePath $script:powershell -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -PassThru -WindowStyle Hidden
    } else {
        $process = Start-Process -FilePath $script:powershell -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    }
    $script:children.Add($process)
    return $process
}

function Stop-Child($Process) {
    try {
        if ($Process -and -not $Process.HasExited) { $Process.Kill() }
    } catch { }
}

try {
    $null = New-Item -ItemType Directory -Path $script:work -Force
    Copy-Item -LiteralPath $script:helperSource -Destination $script:helper -Force

    Test-Case 'helper runs from a copy outside the repository' {
        Assert-True (Test-Path -LiteralPath $script:helper -PathType Leaf) 'helper copy is missing'
        Assert-True (-not $script:helper.StartsWith($script:repoRoot, [StringComparison]::OrdinalIgnoreCase)) 'helper must run outside the repository'
    }

    Test-Case 'helper keeps safe defaults and never terminates the GUI' {
        $source = Get-Content -LiteralPath $script:helperSource -Raw -Encoding UTF8
        Assert-Contains $source '$script:RenameRetrySeconds = 30' 'missing 30 second rename retry default'
        Assert-Contains $source '$script:WaitTimeoutSeconds = 180' 'missing GUI wait default'
        Assert-True (-not ($source.Contains('Stop-Process'))) 'helper must not kill processes'
        Assert-True (-not ($source.Contains('taskkill'))) 'helper must not kill processes'
        Assert-True (-not ($source.Contains('Invoke-WebRequest'))) 'helper must not download anything'
        Assert-True (-not ($source.Contains('http://'))) 'helper must not download anything'
        Assert-True (-not ($source.Contains('https://'))) 'helper must not download anything'
        Assert-True (-not ($source.Contains('Remove-Item -LiteralPath $rootFull'))) 'helper must never delete the install root'
    }

    Test-Case 'successful swap keeps a backup and reports success' {
        $fixture = New-Fixture 'swap'
        Set-Content -LiteralPath $fixture.Download -Value 'zip'
        $job = New-Job $fixture
        $code = Invoke-Helper $job $fixture.Log -NoRestart
        $log = Get-LogText $fixture.Log
        Assert-Equal 0 $code 'successful swap must exit 0'
        Assert-Contains $log 'root-backed-up' 'missing backup step'
        Assert-Contains $log 'staged-activated' 'missing activation step'
        Assert-Contains $log 'update-installed version=1.1.0' 'missing success line'
        Assert-Contains $log 'restart-skipped-fixture' 'fixture mode must not start anything'
        Assert-Equal 'new' (Get-Marker $fixture.Root) 'root must hold the new version'
        Assert-Equal 'old' (Get-Marker $fixture.Backup) 'backup must keep the old version'
        Assert-True (-not (Test-Path -LiteralPath $fixture.Staged)) 'staged directory must be gone'
        Assert-True (-not (Test-Path -LiteralPath $fixture.Download)) 'verified archive must be removed after success'
    }

    Test-Case 'helper waits for the GUI process before swapping' {
        $fixture = New-Fixture 'waits'
        $sleeper = Start-Child @('-NoProfile', '-Command', 'Start-Sleep -Seconds 3')
        try {
            $job = New-Job $fixture -WaitPid $sleeper.Id -WaitSeconds 30
            $stopwatch = [Diagnostics.Stopwatch]::StartNew()
            $code = Invoke-Helper $job $fixture.Log -NoRestart
            $elapsed = $stopwatch.Elapsed.TotalSeconds
        } finally {
            Stop-Child $sleeper
        }
        Assert-Equal 0 $code 'helper must exit 0'
        Assert-True ($elapsed -ge 2.0) ('helper must wait for the GUI before swapping (waited {0:n1}s)' -f $elapsed)
        Assert-Equal 'new' (Get-Marker $fixture.Root) 'root must be swapped only after the wait'
        Assert-Contains (Get-LogText $fixture.Log) 'gui-exited' 'missing gui-exited log'
    }

    Test-Case 'root rename retries while a process keeps the directory busy' {
        $fixture = New-Fixture 'retry'
        $holder = Start-Child @('-NoProfile', '-Command', 'Start-Sleep -Seconds 5') $fixture.Root
        try {
            $job = New-Job $fixture -RetrySeconds 20
            $code = Invoke-Helper $job $fixture.Log -NoRestart
        } finally {
            Stop-Child $holder
        }
        $log = Get-LogText $fixture.Log
        Assert-Equal 0 $code 'helper must eventually rename the root'
        $match = [regex]::Match($log, 'root-backed-up attempts=(\d+)')
        Assert-True $match.Success 'missing retry log line'
        Assert-True ([int]$match.Groups[1].Value -ge 2) ('expected at least two rename attempts, got ' + $match.Groups[1].Value)
        Assert-Equal 'new' (Get-Marker $fixture.Root) 'root must hold the new version after the retry'
    }

    Test-Case 'failed swap restores the old root' {
        $fixture = New-Fixture 'rollback'
        $holder = Start-Child @('-NoProfile', '-Command', 'Start-Sleep -Seconds 6') $fixture.Staged
        try {
            $job = New-Job $fixture
            $code = Invoke-Helper $job $fixture.Log -NoRestart
        } finally {
            Stop-Child $holder
        }
        $log = Get-LogText $fixture.Log
        Assert-Equal 4 $code 'swap failure must exit 4'
        Assert-Contains $log 'swap-failed' 'missing swap failure log'
        Assert-Contains $log 'rollback-restored' 'missing rollback log'
        Assert-Equal 'old' (Get-Marker $fixture.Root) 'old root must be restored'
        Assert-True (-not (Test-Path -LiteralPath $fixture.Backup)) 'backup must be consumed by the rollback'
        Assert-True (-not ($log.Contains('update-installed'))) 'a failed swap must not report success'
    }

    Test-Case 'restart failure restores the old version and reports non-zero' {
        $fixture = New-Fixture 'restart-fail'
        # A missing launcher name fails the spawn without ever executing a fixture file.
        $job = New-Job $fixture -Launcher 'absent-launcher.exe'
        $code = Invoke-Helper $job $fixture.Log
        $log = Get-LogText $fixture.Log
        Assert-Equal 6 $code 'restart failure must exit 6'
        Assert-Contains $log 'restart-skipped-missing' 'missing restart failure log'
        Assert-Contains $log 'rollback-restored-after-restart-failure' 'missing restart rollback log'
        Assert-True (-not ($log.Contains('update-installed'))) 'a failed restart must not report success'
        Assert-Equal 'old' (Get-Marker $fixture.Root) 'old root must be restored after a failed restart'
        Assert-True (-not (Test-Path -LiteralPath $fixture.Backup)) 'backup must be consumed by the rollback'
        $failed = @(Get-ChildItem -LiteralPath $fixture.Parent -Directory -Filter '*.failed-*' -ErrorAction SilentlyContinue)
        Assert-Equal 0 $failed.Count 'the failed new tree must be cleaned up'
    }

    Test-Case 'missing staged directory is reported without touching the root' {
        $fixture = New-Fixture 'missing-staged'
        Remove-Item -LiteralPath $fixture.Staged -Recurse -Force
        $job = New-Job $fixture
        $code = Invoke-Helper $job $fixture.Log -NoRestart
        Assert-Equal 5 $code 'missing staged directory must exit 5'
        Assert-Contains (Get-LogText $fixture.Log) 'staged-missing' 'missing staged-missing log'
        Assert-Equal 'old' (Get-Marker $fixture.Root) 'root must be untouched'
        Assert-True (-not (Test-Path -LiteralPath $fixture.Backup)) 'no backup may be created'
    }

    Test-Case 'job paths outside the root parent are refused' {
        $fixture = New-Fixture 'outside'
        $elsewhere = Join-Path $script:base 'elsewhere'
        $null = New-Item -ItemType Directory -Path $elsewhere
        $moved = Join-Path $elsewhere 'staged'
        Move-Item -LiteralPath $fixture.Staged -Destination $moved
        $job = New-Job $fixture
        $jobData = Get-Content -LiteralPath $job -Raw -Encoding UTF8 | ConvertFrom-Json
        $jobData.staged = $moved
        [IO.File]::WriteAllText($job, ($jobData | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($true)))
        $code = Invoke-Helper $job $fixture.Log -NoRestart
        Assert-Equal 5 $code 'job outside the root parent must exit 5'
        Assert-Contains (Get-LogText $fixture.Log) 'job-outside-parent' 'missing job-outside-parent log'
        Assert-Equal 'old' (Get-Marker $fixture.Root) 'root must be untouched'
    }

    Test-Case 'missing job file exits with the bad-job code' {
        $fixture = New-Fixture 'no-job'
        $code = Invoke-Helper (Join-Path $fixture.Parent 'absent.json') $fixture.Log -NoRestart
        Assert-Equal 5 $code 'missing job file must exit 5'
        Assert-Contains (Get-LogText $fixture.Log) 'job-missing' 'missing job-missing log'
    }

    Write-Host ("Update install tests passed: {0}" -f $script:passed)
} finally {
    foreach ($child in $script:children) { Stop-Child $child }
    Remove-Item -LiteralPath $script:base -Recurse -Force -ErrorAction SilentlyContinue
}
