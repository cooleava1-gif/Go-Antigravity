# Functions are dot-sourceable by scripts/bootstrap-tests.ps1 without launching the UI.
$ErrorActionPreference = 'Stop'

function ConvertTo-GoagyArgument {
    param([AllowEmptyString()][string]$Value)
    $quoted = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $quoted = [regex]::Replace($quoted, '(\\+)$', '$1$1')
    return '"' + $quoted + '"'
}

function Invoke-GoagyCommand {
    param([string]$Executable, [string[]]$Arguments)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-GoagyArgument $_ }) -join ' ')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw ('Could not start ' + $Executable) }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $output = $stdout.GetAwaiter().GetResult()
        $errors = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0 -and $errors) { Write-Host $errors.TrimEnd() }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $output }
    } finally { $process.Dispose() }
}

function Resolve-GoagyCommand {
    param([string]$Name)
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

function Test-GoagyPackagedRuntime {
    param([string]$ProjectRoot)
    $manifest = Join-Path $ProjectRoot 'runtime/manifest.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
    foreach ($path in @('runtime/node/node.exe', 'runtime/python/python.exe', 'runtime/python/pythonw.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $path) -PathType Leaf)) {
            throw "Packaged runtime is incomplete: missing $path. Rebuild the release package."
        }
    }
    return $true
}

function Get-GoagyPackagedNode {
    param([string]$ProjectRoot)
    $candidate = Join-Path $ProjectRoot 'runtime/node/node.exe'
    $result = Invoke-GoagyCommand $candidate @('--version')
    if ($result.ExitCode -ne 0 -or -not (Test-GoagyNodeVersion $result.Output.Trim())) {
        throw 'Bundled Node.js runtime is invalid or older than 22.13.'
    }
    return (Resolve-Path -LiteralPath $candidate).Path
}

function Get-GoagyNode {
    $candidate = Resolve-GoagyCommand 'node.exe'
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        try { $result = Invoke-GoagyCommand $candidate @('--version') } catch { $result = $null }
        if ($result -and $result.ExitCode -eq 0 -and (Test-GoagyNodeVersion $result.Output.Trim())) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw 'Node.js 22.13+ is required. Install Node.js with npm and add node.exe to PATH.'
}

function Get-GoagyNpmCli {
    param([string]$Node)
    $directories = @((Split-Path -Parent $Node))
    foreach ($name in @('npm.cmd', 'npm')) {
        $command = Resolve-GoagyCommand $name
        if ($command) { $directories += Split-Path -Parent $command }
    }
    foreach ($directory in ($directories | Select-Object -Unique)) {
        $cli = Join-Path $directory 'node_modules/npm/bin/npm-cli.js'
        if (Test-Path -LiteralPath $cli -PathType Leaf) { return $cli }
    }
    throw 'npm is required to install backend dependencies. Install Node.js 22.13+ with npm and retry.'
}

function Initialize-GoagyBackend {
    param([string]$ProjectRoot, [string]$Node, [switch]$Packaged)
    $backend = Join-Path $ProjectRoot 'backend'
    $manifest = Join-Path $backend 'package.json'
    $lock = Join-Path $backend 'package-lock.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf) -or -not (Test-Path -LiteralPath $lock -PathType Leaf)) {
        throw 'Missing backend package.json or package-lock.json; restore the complete source checkout.'
    }
    if ($Packaged) {
        $checked = Invoke-GoagyCommand $Node @('-e', 'const p=require("node:path");const b=process.argv[1],m=require(p.join(b,"package.json")),l=require(p.join(b,"package-lock.json"));for(const [n,v] of Object.entries(m.dependencies||{})){if(l.packages[""].dependencies[n]!==v)process.exit(1);const installed=require(p.join(b,"node_modules",n,"package.json"));if(installed.version!==l.packages["node_modules/"+n].version)process.exit(1);require(p.join(b,"node_modules",n));}', $backend)
        if ($checked.ExitCode -ne 0) { throw 'Packaged backend dependencies are missing or do not match package-lock.json.' }
        return
    }
    $fingerprint = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash + ':' + (Get-FileHash -Algorithm SHA256 -LiteralPath $lock).Hash
    $stamp = Join-Path $backend 'node_modules/.goagy-bootstrap-lock'
    $probe = 'const p=require("node:path");const b=process.argv[1],m=require(p.join(b,"package.json")),l=require(p.join(b,"package-lock.json"));for(const [n,v] of Object.entries(m.dependencies||{})){if(l.packages[""].dependencies[n]!==v)process.exit(1);const installed=require(p.join(b,"node_modules",n,"package.json"));if(installed.version!==l.packages["node_modules/"+n].version)process.exit(1);require(p.join(b,"node_modules",n));}'
    $checked = Invoke-GoagyCommand $Node @('-e', $probe, $backend)
    $current = (Test-Path -LiteralPath $stamp -PathType Leaf) -and ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $fingerprint)
    if (-not $current -or $checked.ExitCode -ne 0) {
        $npmCli = Get-GoagyNpmCli $Node
        Write-Host 'Installing locked backend dependencies (npm ci)...'
        $installed = Invoke-GoagyCommand $Node @($npmCli, 'ci', '--prefix', $backend, '--ignore-scripts', '--no-audit', '--no-fund')
        if ($installed.ExitCode -ne 0) { throw 'Backend npm ci failed; desktop was not started. Check npm/network access and retry.' }
        $checked = Invoke-GoagyCommand $Node @('-e', $probe, $backend)
        if ($checked.ExitCode -ne 0) { throw 'Backend dependency verification failed after npm ci; desktop was not started.' }
        Set-Content -LiteralPath $stamp -Value $fingerprint -Encoding ASCII
    }
}

function Test-GoagyNodeVersion {
    param([string]$Version)
    if ($Version -notmatch '^v(\d+\.\d+\.\d+)$') { return $false }
    $number = [version]$Matches[1]
    if ($number.Major -eq 22) { return $number -ge [version]'22.13.0' }
    return $number -ge [version]'23.4.0'
}

function Initialize-GoagyPython {
    param([string]$ProjectRoot, [switch]$Packaged)
    if ($Packaged) {
        $python = Join-Path $ProjectRoot 'runtime/python/python.exe'
        $version = Invoke-GoagyCommand $python @('-c', 'import sys;sys.exit(0 if sys.version_info >= (3,10) else 1)')
        if ($version.ExitCode -ne 0) { throw 'Bundled Python runtime is missing or older than 3.10.' }
        return $python
    }
    $python = Join-Path $ProjectRoot '.venv-qt/Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        $py = Resolve-GoagyCommand 'py.exe'
        $candidates = @(
            [pscustomobject]@{ Executable = $py; Prefix = @('-3') },
            [pscustomobject]@{ Executable = (Resolve-GoagyCommand 'python.exe'); Prefix = @() },
            [pscustomobject]@{ Executable = $py; Prefix = @() }
        )
        $launcher = $null
        $prefix = @()
        foreach ($candidate in $candidates) {
            if (-not $candidate.Executable) { continue }
            try {
                $arguments = @($candidate.Prefix) + @('-c', 'import sys;sys.exit(0 if sys.version_info >= (3,10) else 1)')
                $version = Invoke-GoagyCommand $candidate.Executable $arguments
                if ($version.ExitCode -eq 0) {
                    $launcher = $candidate.Executable
                    $prefix = @($candidate.Prefix)
                    break
                }
            } catch { continue }
        }
        if (-not $launcher) { throw 'Python 3.10+ is required; no supported Python launcher was found. Install Python and retry.' }
        Write-Host 'Creating isolated Python environment...'
        $created = Invoke-GoagyCommand $launcher ($prefix + @('-m', 'venv', (Join-Path $ProjectRoot '.venv-qt')))
        if ($created.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Could not create .venv-qt with Python 3.10+.' }
    }
    $version = Invoke-GoagyCommand $python @('-c', 'import sys;sys.exit(0 if sys.version_info >= (3,10) else 1)')
    if ($version.ExitCode -ne 0) { throw 'Existing .venv-qt requires Python 3.10+; recreate this project environment with a supported Python.' }
    $requirements = Join-Path $ProjectRoot 'desktop-qt/requirements.txt'
    $probe = 'import importlib.metadata as m, pathlib, sys; rows=[r.strip().split("==") for r in pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines() if r.strip() and not r.lstrip().startswith("#")]; sys.exit(0 if all(len(r)==2 and m.version(r[0])==r[1] for r in rows) else 1)'
    $checked = Invoke-GoagyCommand $python @('-c', $probe, $requirements)
    if ($checked.ExitCode -ne 0) {
        $installed = Invoke-GoagyCommand $python @('-m', 'pip', 'install', '-r', $requirements)
        if ($installed.ExitCode -ne 0) { throw 'Python dependency installation failed; desktop was not started.' }
        $checked = Invoke-GoagyCommand $python @('-c', $probe, $requirements)
        if ($checked.ExitCode -ne 0) { throw 'Python dependency versions do not match requirements.txt after installation.' }
    }
    return $python
}

function Wait-GoagyWindowReady {
    param([object]$Process, [string]$ReadyPath, [int]$TimeoutSeconds)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $ReadyPath -PathType Leaf)) {
        if ($Process.HasExited) {
            throw "Desktop window exited before readiness handshake (exit code $($Process.ExitCode))."
        }
        if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
            throw "Desktop window did not complete readiness handshake within $TimeoutSeconds seconds."
        }
        Start-Sleep -Milliseconds 100
    }
}

function Invoke-GoagyBootstrap {
    param([string]$ProjectRoot, [string[]]$AppArguments, [switch]$PrepareOnly,
          [int]$ReadyTimeoutSeconds = 20, [switch]$PassThru)
    $packaged = Test-GoagyPackagedRuntime $ProjectRoot
    if ($packaged) {
        $env:GO_ANTIGRAVITY_PACKAGED = '1'
        $env:PYTHONDONTWRITEBYTECODE = '1'
        $env:PYTHONUTF8 = '1'
    } elseif ($env:GO_ANTIGRAVITY_PACKAGED -eq '1') {
        Remove-Item Env:GO_ANTIGRAVITY_PACKAGED -ErrorAction SilentlyContinue
    }
    $python = Initialize-GoagyPython $ProjectRoot -Packaged:$packaged
    if ($AppArguments -notcontains '--demo') {
        if ($packaged) {
            $env:GO_ANTIGRAVITY_NODE_EXE = Get-GoagyPackagedNode $ProjectRoot
            Initialize-GoagyBackend $ProjectRoot $env:GO_ANTIGRAVITY_NODE_EXE -Packaged
        } else {
            $env:GO_ANTIGRAVITY_NODE_EXE = Get-GoagyNode
            Initialize-GoagyBackend $ProjectRoot $env:GO_ANTIGRAVITY_NODE_EXE
        }
    }
    if (-not $env:GOAGY_CLOUDFLARED) {
        $connector = Resolve-GoagyCommand 'cloudflared.exe'
        $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
        if (-not $connector -and $programFilesX86) { $connector = Join-Path $programFilesX86 'cloudflared/cloudflared.exe' }
        if ($connector -and (Test-Path -LiteralPath $connector -PathType Leaf)) { $env:GOAGY_CLOUDFLARED = $connector }
    }
    if ($PrepareOnly) { return }
    $entry = Join-Path $ProjectRoot 'desktop-qt/main.py'
    if ($env:GOAGY_QT_CONSOLE -eq '1') {
        & $python -B $entry @AppArguments
        exit $LASTEXITCODE
    }
    if ($packaged) {
        $pythonw = Join-Path $ProjectRoot 'runtime/python/pythonw.exe'
        if (-not (Test-Path -LiteralPath $pythonw -PathType Leaf)) { throw 'Missing bundled Python windowed launcher; rebuild the release package.' }
    } else {
        $pythonw = Join-Path $ProjectRoot '.venv-qt/Scripts/pythonw.exe'
        if (-not (Test-Path -LiteralPath $pythonw -PathType Leaf)) { throw 'Missing Python windowed launcher in .venv-qt; recreate the environment.' }
    }
    $launchArgs = (@('-B', $entry) + $AppArguments | ForEach-Object { ConvertTo-GoagyArgument $_ }) -join ' '
    $readyDir = Join-Path ([IO.Path]::GetTempPath()) ('goagy-qt-' + [guid]::NewGuid().ToString('N'))
    $readyPath = Join-Path $readyDir 'ready'
    $null = New-Item -ItemType Directory -Path $readyDir
    $previousReadyPath = $env:GOAGY_QT_READY_FILE
    $desktop = $null
    try {
        $env:GOAGY_QT_READY_FILE = $readyPath
        $desktop = Start-Process -FilePath $pythonw -ArgumentList $launchArgs -WorkingDirectory $ProjectRoot -PassThru
        Wait-GoagyWindowReady $desktop $readyPath $ReadyTimeoutSeconds
        if ($PassThru) { return $desktop }
    } catch {
        if ($desktop -and -not $desktop.HasExited) {
            try { $desktop.Kill() } catch [InvalidOperationException] { if (-not $desktop.HasExited) { throw } }
        }
        if ($desktop -and $PassThru) { $desktop.Dispose() }
        throw
    } finally {
        $env:GOAGY_QT_READY_FILE = $previousReadyPath
        if ($desktop -and -not $PassThru) { $desktop.Dispose() }
        Remove-Item -LiteralPath $readyPath -ErrorAction SilentlyContinue
        [IO.Directory]::Delete($readyDir)
    }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-GoagyBootstrap -ProjectRoot $PSScriptRoot -AppArguments $args }
