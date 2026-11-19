param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
. (Join-Path $ProjectRoot 'Start-Go-Antigravity.ps1')
$script:passed = 0
$script:base = Join-Path ([IO.Path]::GetTempPath()) ('goagy-bootstrap-test-' + [guid]::NewGuid())
$oldNode = $env:GO_ANTIGRAVITY_NODE_EXE
$oldCloud = $env:GOAGY_CLOUDFLARED
$oldReady = $env:GOAGY_QT_READY_FILE
function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $caught = $false
    try { & $Action } catch { $caught = $true; Assert-True ($_.Exception.Message -like ('*' + $Message + '*')) ('Unexpected failure: ' + $_.Exception.Message) }
    Assert-True $caught ('Expected failure: ' + $Message)
}
function New-Fixture {
    $root = Join-Path $script:base ([guid]::NewGuid())
    @('backend', 'desktop-qt', '.venv-qt/Scripts', 'system/node_modules/npm/bin') | ForEach-Object { New-Item -ItemType Directory -Path (Join-Path $root $_) -Force | Out-Null }
    @('.venv-qt/Scripts/python.exe', '.venv-qt/Scripts/pythonw.exe', 'system/node.exe', 'system/node_modules/npm/bin/npm-cli.js') | ForEach-Object { Set-Content -LiteralPath (Join-Path $root $_) -Value 'synthetic stub' }
    Set-Content -LiteralPath (Join-Path $root 'backend/package.json') -Value '{"dependencies":{"ws":"^8.21.3"}}'
    Set-Content -LiteralPath (Join-Path $root 'backend/package-lock.json') -Value '{"lockfileVersion":3}'
    Set-Content -LiteralPath (Join-Path $root 'desktop-qt/requirements.txt') -Value 'PyQt6==6.12.1'
    $script:fixture = $root
    $script:nodeVersion = 'v22.23.3'
    $script:pythonVersion = 0
    $script:pyVersion = 0
    $script:pyThrows = $false
    $script:deps = $false
    $script:pythonDeps = $true
    $script:npmExit = 0
    $script:brokenInstall = $false
    $script:pipExit = 0
    $script:calls = @()
    $script:launches = 0
    $script:launchMode = 'success'
    return $root
}
function Resolve-GoagyCommand {
    param([string]$Name)
    if ($Name -eq 'node.exe') { return (Join-Path $script:fixture 'system/node.exe') }
    if ($Name -eq 'py.exe') { return (Join-Path $script:fixture 'system/py.exe') }
    if ($Name -eq 'python.exe') { return (Join-Path $script:fixture 'system/python.exe') }
    if ($Name -eq 'npm.cmd') { return (Join-Path $script:fixture 'system/npm.cmd') }
    return $null
}
function Invoke-GoagyCommand {
    param([string]$Executable, [string[]]$Arguments)
    $script:calls += ,@($Executable, $Arguments)
    $code = 0
    $output = ''
    if ($Arguments -contains '--version') {
        $output = $script:nodeVersion
    }
    elseif ($Arguments -contains 'ci') {
        $code = $script:npmExit
        if ($code -eq 0) { $script:deps = -not $script:brokenInstall; New-Item -ItemType Directory -Path (Join-Path $script:fixture 'backend/node_modules') -Force | Out-Null }
    }
    elseif ($Arguments -contains 'pip') { $code = $script:pipExit; if ($code -eq 0) { $script:pythonDeps = $true } }
    elseif ($Arguments -contains 'venv') {
        New-Item -ItemType Directory -Path (Join-Path $script:fixture '.venv-qt/Scripts') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:fixture '.venv-qt/Scripts/python.exe') -Value 'synthetic stub'
    }
    elseif ($Arguments -contains '-e') { if (-not $script:deps) { $code = 1 } }
    elseif (($Arguments -join ' ') -like '*version_info*') {
        if ($Executable -eq (Join-Path $script:fixture 'system/py.exe')) {
            if ($script:pyThrows) { throw 'Synthetic broken Python launcher' }
            $code = $script:pyVersion
        } else { $code = $script:pythonVersion }
    }
    elseif (($Arguments -join ' ') -like '*importlib.metadata*') { if (-not $script:pythonDeps) { $code = 1 } }
    return [pscustomobject]@{ExitCode = $code; Output = $output}
}
function Start-Process {
    param($FilePath, $ArgumentList, $WorkingDirectory, [switch]$PassThru)
    $script:launches++
    $child = [pscustomobject]@{ HasExited = ($script:launchMode -eq 'early'); ExitCode = 17 }
    $child | Add-Member ScriptMethod Dispose {}
    $child | Add-Member ScriptMethod Kill { $script:timedOutChildStopped = $true }
    if ($script:launchMode -eq 'success') {
        Set-Content -LiteralPath $env:GOAGY_QT_READY_FILE -Value 'ready'
    }
    $script:readyDir = Split-Path -Parent $env:GOAGY_QT_READY_FILE
    return $child
}
function Test-Case([string]$Name, [scriptblock]$Body) {
    & $Body
    $script:passed++
    Write-Host ('PASS ' + $Name)
}
try {
    New-Item -ItemType Directory -Path $script:base -Force | Out-Null
    Test-Case 'system Node and first npm ci' {
        $root = New-Fixture
        Invoke-GoagyBootstrap $root @() -PrepareOnly
        Assert-True ($env:GO_ANTIGRAVITY_NODE_EXE -eq (Join-Path $root 'system/node.exe')) 'System Node was not passed to runtime'
        Assert-True (@($script:calls | Where-Object { $_[1] -contains 'ci' }).Count -eq 1) 'Expected one npm ci'
        Assert-True ($script:launches -eq 0) 'PrepareOnly launched desktop'
    }
    Test-Case 'legacy executable is ignored and valid dependencies are reused' {
        $root = New-Fixture
        Set-Content -LiteralPath (Join-Path $root 'legacy-node.exe') -Value 'synthetic bundled'
        Invoke-GoagyBootstrap $root @() -PrepareOnly
        Invoke-GoagyBootstrap $root @() -PrepareOnly
        Assert-True ($env:GO_ANTIGRAVITY_NODE_EXE -eq (Join-Path $root 'system/node.exe')) 'Legacy executable was preferred'
        Assert-True (@($script:calls | Where-Object { $_[0] -eq (Join-Path $root 'legacy-node.exe') }).Count -eq 0) 'Legacy executable was invoked'
        Assert-True (@($script:calls | Where-Object { $_[1] -contains 'ci' }).Count -eq 1) 'Repeated npm ci on unchanged dependencies'
    }
    Test-Case 'lock changes trigger npm ci again' {
        $root = New-Fixture
        Invoke-GoagyBootstrap $root @() -PrepareOnly
        Add-Content -LiteralPath (Join-Path $root 'backend/package-lock.json') -Value ' '
        Invoke-GoagyBootstrap $root @() -PrepareOnly
        Assert-True (@($script:calls | Where-Object { $_[1] -contains 'ci' }).Count -eq 2) 'Lock change was ignored'
    }
    Test-Case 'npm failure prevents desktop launch' {
        $root = New-Fixture
        $script:npmExit = 17
        Assert-Throws { Invoke-GoagyBootstrap $root @() } 'npm ci failed'
        Assert-True ($script:launches -eq 0) 'Desktop launched after npm failure'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $root 'backend/node_modules/.goagy-bootstrap-lock'))) 'Failure created successful stamp'
    }
    Test-Case 'demo requires no Node or backend' {
        $root = New-Fixture
        Remove-Item -LiteralPath (Join-Path $root 'backend') -Recurse -Force
        Remove-Item -LiteralPath (Join-Path $root 'system') -Recurse -Force
        Invoke-GoagyBootstrap $root @('--demo') -PrepareOnly
        Assert-True (@($script:calls | Where-Object { $_[1] -contains '--version' }).Count -eq 0) 'Demo checked Node'
    }
    Test-Case 'windowed startup completes the readiness handshake' {
        $root = New-Fixture
        Invoke-GoagyBootstrap $root @('--demo')
        Assert-True ($script:launches -eq 1) 'Windowed desktop was not launched'
        Assert-True ($env:GOAGY_QT_READY_FILE -eq $oldReady) 'Readiness environment leaked into the bootstrap process'
    }
    Test-Case 'windowed startup reports an early child exit' {
        $root = New-Fixture
        $script:launchMode = 'early'
        Assert-Throws { Invoke-GoagyBootstrap $root @('--demo') -ReadyTimeoutSeconds 1 } 'exited before readiness handshake'
        Assert-True ($script:launches -eq 1) 'Windowed desktop was not launched'
    }
    Test-Case 'windowed startup reports a readiness timeout' {
        $root = New-Fixture
        $script:launchMode = 'timeout'
        $script:timedOutChildStopped = $false
        Assert-Throws { Invoke-GoagyBootstrap $root @('--demo') -ReadyTimeoutSeconds 0 } 'did not complete readiness handshake'
        Assert-True $script:timedOutChildStopped 'Timed out child is still running'
        Assert-True (-not (Test-Path -LiteralPath $script:readyDir)) 'Readiness directory was left behind'
    }
    Test-Case 'old Node is rejected' {
        $root = New-Fixture
        $script:nodeVersion = 'v20.19.0'
        Assert-Throws { Invoke-GoagyBootstrap $root @() } 'Node.js 22.13+'
        Assert-True ($script:launches -eq 0) 'Old Node launched desktop'
    }
    Test-Case 'Node 22 before the sqlite-supported minor is rejected' {
        $root = New-Fixture
        $script:nodeVersion = 'v22.12.0'
        Assert-Throws { Invoke-GoagyBootstrap $root @() } 'Node.js 22.13+'
        Assert-True ($script:launches -eq 0) 'Unsupported Node launched desktop'
    }
    Test-Case 'old existing Python is rejected' {
        $root = New-Fixture
        $script:pythonVersion = 1
        Assert-Throws { Invoke-GoagyBootstrap $root @('--demo') } 'Existing .venv-qt'
        Assert-True ($script:launches -eq 0) 'Old Python launched desktop'
    }
    Test-Case 'Python pinned dependency mismatch installs and rechecks' {
        $root = New-Fixture
        $script:pythonDeps = $false
        Invoke-GoagyBootstrap $root @('--demo') -PrepareOnly
        Assert-True (@($script:calls | Where-Object { $_[1] -contains 'pip' }).Count -eq 1) 'Pinned dependency mismatch not installed'
        Assert-True $script:pythonDeps 'Python dependencies not rechecked'
    }
    Test-Case 'pip failure prevents desktop launch' {
        $root = New-Fixture
        $script:pythonDeps = $false
        $script:pipExit = 4
        Assert-Throws { Invoke-GoagyBootstrap $root @('--demo') } 'Python dependency installation failed'
        Assert-True ($script:launches -eq 0) 'pip failure launched desktop'
    }
    Test-Case 'legacy executable cannot replace missing system Node' {
        $root = New-Fixture
        Set-Content -LiteralPath (Join-Path $root 'legacy-node.exe') -Value 'synthetic legacy'
        Remove-Item -LiteralPath (Join-Path $root 'system/node.exe')
        Assert-Throws { Invoke-GoagyBootstrap $root @() } 'Node.js 22.13+'
        Assert-True ($script:launches -eq 0) 'Desktop launched with legacy Node'
        Assert-True (@($script:calls | Where-Object { $_[1] -contains '--version' }).Count -eq 0) 'Legacy executable was invoked'
    }
    Test-Case 'successful npm exit with broken dependencies still prevents launch' {
        $root = New-Fixture
        $script:brokenInstall = $true
        Assert-Throws { Invoke-GoagyBootstrap $root @() } 'verification failed after npm ci'
        Assert-True ($script:launches -eq 0) 'Broken dependencies launched desktop'
    }
    Test-Case 'damaged dependencies invalidate unchanged lock stamp' {
        $root = New-Fixture
        Invoke-GoagyBootstrap $root @() -PrepareOnly
        $script:deps = $false
        Invoke-GoagyBootstrap $root @() -PrepareOnly
        Assert-True (@($script:calls | Where-Object { $_[1] -contains 'ci' }).Count -eq 2) 'Damaged dependencies not reinstalled'
    }
    Test-Case 'fresh Python venv is created after minimum version check' {
        $root = New-Fixture
        Remove-Item -LiteralPath (Join-Path $root '.venv-qt') -Recurse -Force
        Invoke-GoagyBootstrap $root @('--demo') -PrepareOnly
        Assert-True (@($script:calls | Where-Object { $_[1] -contains 'venv' }).Count -eq 1) 'New environment not created'
    }
    Test-Case 'unsupported py alias falls back to working python' {
        $root = New-Fixture
        Remove-Item -LiteralPath (Join-Path $root '.venv-qt') -Recurse -Force
        $script:pyVersion = 2
        Invoke-GoagyBootstrap $root @('--demo') -PrepareOnly
        $creation = @($script:calls | Where-Object { $_[1] -contains 'venv' })
        Assert-True ($creation.Count -eq 1 -and $creation[0][0] -eq (Join-Path $root 'system/python.exe')) 'Unusable py alias blocked Python fallback'
        Assert-True ($creation[0][1] -notcontains '-3') 'Python executable received py-only flag'
    }
    Test-Case 'broken py executable falls back to working python' {
        $root = New-Fixture
        Remove-Item -LiteralPath (Join-Path $root '.venv-qt') -Recurse -Force
        $script:pyThrows = $true
        Invoke-GoagyBootstrap $root @('--demo') -PrepareOnly
        Assert-True (@($script:calls | Where-Object { $_[0] -eq (Join-Path $root 'system/python.exe') -and $_[1] -contains 'venv' }).Count -eq 1) 'Broken py executable blocked fallback'
    }
    Test-Case 'all unsupported fresh Python candidates stop before creating environment' {
        $root = New-Fixture
        Remove-Item -LiteralPath (Join-Path $root '.venv-qt') -Recurse -Force
        $script:pyVersion = 1
        $script:pythonVersion = 1
        Assert-Throws { Invoke-GoagyBootstrap $root @('--demo') -PrepareOnly } 'Python 3.10+'
        Assert-True (@($script:calls | Where-Object { $_[1] -contains 'venv' }).Count -eq 0) 'Unsupported Python created environment'
        Assert-True ($script:launches -eq 0) 'Unsupported Python launched desktop'
    }
    Write-Host ('Bootstrap synthetic tests: ' + $script:passed + ' passed, 0 failed')
} finally {
    $env:GO_ANTIGRAVITY_NODE_EXE = $oldNode
    $env:GOAGY_CLOUDFLARED = $oldCloud
    $env:GOAGY_QT_READY_FILE = $oldReady
    if (Test-Path -LiteralPath $script:base) { Remove-Item -LiteralPath $script:base -Recurse -Force }
}
