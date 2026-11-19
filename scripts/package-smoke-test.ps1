[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackagePath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package-rules.ps1')

function Assert-Smoke([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Package smoke test failed: $Message" }
}

$source = (Resolve-Path -LiteralPath $PackagePath).Path
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ([IO.Path]::GetRandomFileName())
$null = New-Item -ItemType Directory -Path $tempRoot
$environment = @{}
foreach ($key in @('LOCALAPPDATA', 'GO_ANTIGRAVITY_PACKAGED', 'GO_ANTIGRAVITY_DATA_DIR', 'GO_ANTIGRAVITY_NODE_EXE',
                   'GOAGY_QT_CONSOLE', 'GOAGY_CLOUDFLARED', 'QT_QPA_PLATFORM', 'PYTHONUTF8', 'PYTHONDONTWRITEBYTECODE')) {
    $environment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
try {
    Expand-Archive -LiteralPath $source -DestinationPath $tempRoot
    $entries = @(Get-ChildItem -LiteralPath $tempRoot -Force)
    Assert-Smoke ($entries.Count -eq 1 -and $entries[0].PSIsContainer -and $entries[0].Name -eq 'Go-Antigravity-windows-x64') 'unexpected ZIP root'
    $root = $entries[0].FullName
    $forbidden = @(Get-PackageForbiddenItems $root)
    Assert-Smoke ($forbidden.Count -eq 0) ("forbidden package entry: " + ($forbidden | Select-Object -First 1 -ExpandProperty FullName))

    $manifest = Get-Content -Raw -LiteralPath (Join-Path $root 'runtime/manifest.json') | ConvertFrom-Json
    Assert-Smoke ($manifest.package -eq 'Go-Antigravity' -and $manifest.platform -eq 'windows-x64') 'wrong manifest'
    Assert-Smoke ($manifest.version -and $manifest.commit -and $manifest.launcher -eq 'Go-Antigravity.exe') 'missing release identity'
    Assert-Smoke ($manifest.node.executable -eq 'runtime/node/node.exe' -and
                  $manifest.python.executable -eq 'runtime/python/pythonw.exe' -and
                  $manifest.backend.entry -eq 'backend/server.js' -and $manifest.backend.dependencies -eq 'backend/node_modules' -and
                  $manifest.dataDirectory -eq '%LOCALAPPDATA%\Go-Antigravity') 'invalid manifest paths'
    foreach ($file in @($manifest.launcher, $manifest.backend.entry, $manifest.python.importPath)) {
        Assert-Smoke (Test-Path -LiteralPath (Join-Path $root $file) -PathType Leaf) "missing $file"
    }

    $env:LOCALAPPDATA = Join-Path $tempRoot 'profile'
    $env:QT_QPA_PLATFORM = 'offscreen'
    foreach ($key in @('GO_ANTIGRAVITY_PACKAGED','GO_ANTIGRAVITY_DATA_DIR','GOAGY_QT_CONSOLE','GO_ANTIGRAVITY_NODE_EXE')) {
        [Environment]::SetEnvironmentVariable($key, $null, 'Process')
    }
    . (Join-Path $root 'Start-Go-Antigravity.ps1')
    Invoke-GoagyBootstrap -ProjectRoot $root -AppArguments @() -PrepareOnly
    $node = Join-Path $root $manifest.node.executable
    Assert-Smoke ($env:GO_ANTIGRAVITY_PACKAGED -eq '1' -and $env:GO_ANTIGRAVITY_NODE_EXE -eq $node) 'bootstrap did not select the bundled Node in packaged mode'

    # Load the complete backend graph and exercise SQLite, without opening a real account or a listener.
    $probe = @'
const path = require('node:path'), assert = require('node:assert/strict');
const root = process.argv[1];
const { createApplication } = require(path.join(root, 'backend/desktop/application'));
const { resolveDataDirectory } = require(path.join(root, 'backend/core/runtime-data'));
const { DatabaseSync } = require('node:sqlite');
assert.equal(typeof createApplication, 'function');
assert.equal(process.version, process.argv[2]);
assert.equal(resolveDataDirectory(path.join(root,'backend'), process.env), path.join(process.env.LOCALAPPDATA,'Go-Antigravity'));
const db = new DatabaseSync(':memory:');
try { assert.equal(db.prepare('select 1 as ok').get().ok, 1); } finally { db.close(); }
'@
    $result = Invoke-GoagyCommand $node @('-e', $probe, $root, $manifest.node.version)
    Assert-Smoke ($result.ExitCode -eq 0) 'bundled backend or its data directory failed'
    $python = Join-Path $root 'runtime/python/python.exe'
    $result = Invoke-GoagyCommand $python @('-B', '-c', 'import platform; print(platform.python_version())')
    Assert-Smoke ($result.ExitCode -eq 0 -and $result.Output.Trim() -eq $manifest.python.version) 'wrong bundled Python version'

    $window = Invoke-GoagyBootstrap -ProjectRoot $root -AppArguments @('--demo', '--quit-after', '150') -PassThru
    try {
        Assert-Smoke ($window.WaitForExit(10000) -and $window.ExitCode -eq 0) 'demo did not exit normally'
    } finally {
        if (-not $window.HasExited) { $window.Kill(); $window.WaitForExit() }
        $window.Dispose()
    }
    Write-Host "Package smoke passed: $($manifest.node.version), Python $($manifest.python.version), packaged data directory and windowed demo"
} finally {
    foreach ($key in $environment.Keys) { [Environment]::SetEnvironmentVariable($key, $environment[$key], 'Process') }
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($tempRoot)) -eq $tempBase.TrimEnd('\')) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
