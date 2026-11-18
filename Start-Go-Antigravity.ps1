# Functions are dot-sourceable by scripts/bootstrap-tests.ps1 without launching the UI.
$ErrorActionPreference = 'Stop'

function ConvertTo-EasyAgArgument {
    param([AllowEmptyString()][string]$Value)
    $quoted = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $quoted = [regex]::Replace($quoted, '(\\+)$', '$1$1')
    return '"' + $quoted + '"'
}

function Invoke-EasyAgCommand {
    param([string]$Executable, [string[]]$Arguments)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-EasyAgArgument $_ }) -join ' ')
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

function Resolve-EasyAgCommand {
    param([string]$Name)
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

function Test-EasyAgPackagedRuntime {
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

function Get-EasyAgPackagedNode {
    param([string]$ProjectRoot)
    $candidate = Join-Path $ProjectRoot 'runtime/node/node.exe'
    $result = Invoke-EasyAgCommand $candidate @('--version')
    if ($result.ExitCode -ne 0 -or $result.Output.Trim() -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw 'Bundled Node.js runtime is invalid or older than 22.'
    }
    return (Resolve-Path -LiteralPath $candidate).Path
}

function Get-EasyAgNode {
    $candidate = Resolve-EasyAgCommand 'node.exe'
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        try { $result = Invoke-EasyAgCommand $candidate @('--version') } catch { $result = $null }
        if ($result -and $result.ExitCode -eq 0 -and $result.Output.Trim() -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw 'Node.js 22+ is required. Install Node.js with npm and add node.exe to PATH.'
}

function Get-EasyAgNpmCli {
    param([string]$Node)
    $directories = @((Split-Path -Parent $Node))
    foreach ($name in @('npm.cmd', 'npm')) {
        $command = Resolve-EasyAgCommand $name
        if ($command) { $directories += Split-Path -Parent $command }
    }
    foreach ($directory in ($directories | Select-Object -Unique)) {
        $cli = Join-Path $directory 'node_modules/npm/bin/npm-cli.js'
        if (Test-Path -LiteralPath $cli -PathType Leaf) { return $cli }
    }
    throw 'npm is required to install backend dependencies. Install Node.js 22+ with npm and retry.'
}

function Initialize-EasyAgBackend {
    param([string]$ProjectRoot, [string]$Node, [switch]$Packaged)
    $backend = Join-Path $ProjectRoot 'backend'
    $manifest = Join-Path $backend 'package.json'
    $lock = Join-Path $backend 'package-lock.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf) -or -not (Test-Path -LiteralPath $lock -PathType Leaf)) {
        throw 'Missing backend package.json or package-lock.json; restore the complete source checkout.'
    }
    if ($Packaged) {
        $checked = Invoke-EasyAgCommand $Node @('-e', 'const p=require("node:path");const b=process.argv[1],m=require(p.join(b,"package.json")),l=require(p.join(b,"package-lock.json"));for(const [n,v] of Object.entries(m.dependencies||{})){if(l.packages[""].dependencies[n]!==v)process.exit(1);const installed=require(p.join(b,"node_modules",n,"package.json"));if(installed.version!==l.packages["node_modules/"+n].version)process.exit(1);require(p.join(b,"node_modules",n));}', $backend)
        if ($checked.ExitCode -ne 0) { throw 'Packaged backend dependencies are missing or do not match package-lock.json.' }
        return
    }
    $fingerprint = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash + ':' + (Get-FileHash -Algorithm SHA256 -LiteralPath $lock).Hash
    $stamp = Join-Path $backend 'node_modules/.easyag-bootstrap-lock'
    $probe = 'const p=require("node:path");const b=process.argv[1],m=require(p.join(b,"package.json")),l=require(p.join(b,"package-lock.json"));for(const [n,v] of Object.entries(m.dependencies||{})){if(l.packages[""].dependencies[n]!==v)process.exit(1);const installed=require(p.join(b,"node_modules",n,"package.json"));if(installed.version!==l.packages["node_modules/"+n].version)process.exit(1);require(p.join(b,"node_modules",n));}'
    $checked = Invoke-EasyAgCommand $Node @('-e', $probe, $backend)
    $current = (Test-Path -LiteralPath $stamp -PathType Leaf) -and ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $fingerprint)
    if (-not $current -or $checked.ExitCode -ne 0) {
        $npmCli = Get-EasyAgNpmCli $Node
        Write-Host 'Installing locked backend dependencies (npm ci)...'
        $installed = Invoke-EasyAgCommand $Node @($npmCli, 'ci', '--prefix', $backend, '--ignore-scripts', '--no-audit', '--no-fund')
        if ($installed.ExitCode -ne 0) { throw 'Backend npm ci failed; desktop was not started. Check npm/network access and retry.' }
        $checked = Invoke-EasyAgCommand $Node @('-e', $probe, $backend)
        if ($checked.ExitCode -ne 0) { throw 'Backend dependency verification failed after npm ci; desktop was not started.' }
        Set-Content -LiteralPath $stamp -Value $fingerprint -Encoding ASCII
    }
}

function Initialize-EasyAgPython {
    param([string]$ProjectRoot, [switch]$Packaged)
    if ($Packaged) {
        $python = Join-Path $ProjectRoot 'runtime/python/python.exe'
        $version = Invoke-EasyAgCommand $python @('-c', 'import sys;sys.exit(0 if sys.version_info >= (3,10) else 1)')
        if ($version.ExitCode -ne 0) { throw 'Bundled Python runtime is missing or older than 3.10.' }
        return $python
    }
    $python = Join-Path $ProjectRoot '.venv-qt/Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        $py = Resolve-EasyAgCommand 'py.exe'
        $candidates = @(
            [pscustomobject]@{ Executable = $py; Prefix = @('-3') },
            [pscustomobject]@{ Executable = (Resolve-EasyAgCommand 'python.exe'); Prefix = @() },
            [pscustomobject]@{ Executable = $py; Prefix = @() }
        )
        $launcher = $null
        $prefix = @()
        foreach ($candidate in $candidates) {
            if (-not $candidate.Executable) { continue }
            try {
                $arguments = @($candidate.Prefix) + @('-c', 'import sys;sys.exit(0 if sys.version_info >= (3,10) else 1)')
                $version = Invoke-EasyAgCommand $candidate.Executable $arguments
                if ($version.ExitCode -eq 0) {
                    $launcher = $candidate.Executable
                    $prefix = @($candidate.Prefix)
                    break
                }
            } catch { continue }
        }
        if (-not $launcher) { throw 'Python 3.10+ is required; no supported Python launcher was found. Install Python and retry.' }
        Write-Host 'Creating isolated Python environment...'
        $created = Invoke-EasyAgCommand $launcher ($prefix + @('-m', 'venv', (Join-Path $ProjectRoot '.venv-qt')))
        if ($created.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Could not create .venv-qt with Python 3.10+.' }
    }
    $version = Invoke-EasyAgCommand $python @('-c', 'import sys;sys.exit(0 if sys.version_info >= (3,10) else 1)')
    if ($version.ExitCode -ne 0) { throw 'Existing .venv-qt requires Python 3.10+; recreate this project environment with a supported Python.' }
    $requirements = Join-Path $ProjectRoot 'desktop-qt/requirements.txt'
    $probe = 'import importlib.metadata as m, pathlib, sys; rows=[r.strip().split("==") for r in pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines() if r.strip() and not r.lstrip().startswith("#")]; sys.exit(0 if all(len(r)==2 and m.version(r[0])==r[1] for r in rows) else 1)'
    $checked = Invoke-EasyAgCommand $python @('-c', $probe, $requirements)
    if ($checked.ExitCode -ne 0) {
        $installed = Invoke-EasyAgCommand $python @('-m', 'pip', 'install', '-r', $requirements)
        if ($installed.ExitCode -ne 0) { throw 'Python dependency installation failed; desktop was not started.' }
        $checked = Invoke-EasyAgCommand $python @('-c', $probe, $requirements)
        if ($checked.ExitCode -ne 0) { throw 'Python dependency versions do not match requirements.txt after installation.' }
    }
    return $python
}

function Invoke-EasyAgBootstrap {
    param([string]$ProjectRoot, [string[]]$AppArguments, [switch]$PrepareOnly)
    $packaged = Test-EasyAgPackagedRuntime $ProjectRoot
    if ($packaged) {
        $env:GO_ANTIGRAVITY_PACKAGED = '1'
        $env:PYTHONDONTWRITEBYTECODE = '1'
        $env:PYTHONUTF8 = '1'
    } elseif ($env:GO_ANTIGRAVITY_PACKAGED -eq '1') {
        Remove-Item Env:GO_ANTIGRAVITY_PACKAGED -ErrorAction SilentlyContinue
    }
    $python = Initialize-EasyAgPython $ProjectRoot -Packaged:$packaged
    if ($AppArguments -notcontains '--demo') {
        if ($packaged) {
            $env:GO_ANTIGRAVITY_NODE_EXE = Get-EasyAgPackagedNode $ProjectRoot
            Initialize-EasyAgBackend $ProjectRoot $env:GO_ANTIGRAVITY_NODE_EXE -Packaged
        } else {
            $env:GO_ANTIGRAVITY_NODE_EXE = Get-EasyAgNode
            Initialize-EasyAgBackend $ProjectRoot $env:GO_ANTIGRAVITY_NODE_EXE
        }
    }
    if (-not $env:AGY_CLOUDFLARED) {
        $connector = Resolve-EasyAgCommand 'cloudflared.exe'
        $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
        if (-not $connector -and $programFilesX86) { $connector = Join-Path $programFilesX86 'cloudflared/cloudflared.exe' }
        if ($connector -and (Test-Path -LiteralPath $connector -PathType Leaf)) { $env:AGY_CLOUDFLARED = $connector }
    }
    if ($PrepareOnly) { return }
    $entry = Join-Path $ProjectRoot 'desktop-qt/main.py'
    if ($env:EASYAG_QT_CONSOLE -eq '1') {
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
    $launchArgs = @('-B', ('"' + $entry + '"')) + $AppArguments
    Start-Process -FilePath $pythonw -ArgumentList $launchArgs -WorkingDirectory $ProjectRoot
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-EasyAgBootstrap -ProjectRoot $PSScriptRoot -AppArguments $args }
