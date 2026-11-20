# Delivered-source traceability for the Windows release package.
# Dot-sourced by scripts/package-windows.ps1 (build), scripts/verify-package-source.ps1
# (post-copy verification) and the package tests. The file-set rules below describe
# exactly the source files the package delivers, so build and verification compute the
# same fingerprint from a package directory or an extracted ZIP.

. (Join-Path $PSScriptRoot 'package-rules.ps1')

function Get-PackageSourceTopLevelFiles {
    # Root documents copied verbatim into the package by package-windows.ps1.
    return @(
        'Start-Go-Antigravity.ps1', 'Start-Go-Antigravity.cmd',
        'README.md', 'PORTABLE.md', 'LICENSE', 'MOBILE-ACCESS.md', 'THIRD-PARTY-NOTICES.md'
    )
}

function Get-PackageSourceAliasMap {
    # package-windows.ps1 copies backend/THIRD-PARTY-NOTICES.md to the package root, so a
    # package delivers that document twice while the source tree only has it under backend/.
    # Both delivered paths stay separate in the fingerprint; the map only says where to read
    # the content of a path that is missing on the side being hashed.
    return @{ 'THIRD-PARTY-NOTICES.md' = 'backend/THIRD-PARTY-NOTICES.md' }
}

function Get-PackageSourceFilePath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$RelativePath
    )

    $primary = Join-Path $Root ($RelativePath.Replace('/', '\'))
    if (Test-Path -LiteralPath $primary -PathType Leaf) { return $primary }
    $aliasMap = Get-PackageSourceAliasMap
    if ($aliasMap.ContainsKey($RelativePath)) {
        $alias = Join-Path $Root ($aliasMap[$RelativePath].Replace('/', '\'))
        if (Test-Path -LiteralPath $alias -PathType Leaf) { return $alias }
    }
    throw "Missing delivered source file: $RelativePath under $Root"
}

function Test-PackageSourceRelativePath {
    param([Parameter(Mandatory)][string]$RelativePath)

    $relative = $RelativePath.Replace('\', '/').TrimStart('/')
    if (-not $relative) { return $false }
    if (Test-PackageForbiddenRelativePath $relative) { return $false }
    if ($relative -like 'backend/*') {
        # npm dependencies and the portable runtime folder are not delivered source.
        return $relative -notmatch '(^|/)(node_modules|runtime)(/|$)'
    }
    if ($relative -like 'desktop-qt/*') {
        $name = ($relative -split '/')[-1]
        return $name -notmatch '^(test_.*|smoke_test)\.py$'
    }
    return ((Get-PackageSourceTopLevelFiles) -contains $relative)
}

function Get-PackageSourceFiles {
    param([Parameter(Mandatory)][string]$Root)

    $rootPath = ([IO.Path]::GetFullPath($Root)).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) { throw "Missing package directory: $rootPath" }
    $files = New-Object System.Collections.Generic.List[string]
    # The packaged root documents are a fixed delivered set; THIRD-PARTY-NOTICES.md is
    # copied from backend/THIRD-PARTY-NOTICES.md, so the source side reads its content there.
    foreach ($relative in (Get-PackageSourceTopLevelFiles)) {
        $files.Add($relative)
    }
    foreach ($directory in @('backend', 'desktop-qt')) {
        $base = Join-Path $rootPath $directory
        if (-not (Test-Path -LiteralPath $base -PathType Container)) { continue }
        foreach ($item in Get-ChildItem -LiteralPath $base -Recurse -Force -File) {
            $relative = ($item.FullName.Substring($rootPath.Length).TrimStart('\')).Replace('\', '/')
            if (Test-PackageSourceRelativePath $relative) { $files.Add($relative) }
        }
    }
    $sorted = $files.ToArray()
    [Array]::Sort($sorted, [StringComparer]::Ordinal)
    return $sorted
}

function ConvertTo-HexString {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    $builder = New-Object Text.StringBuilder
    foreach ($byte in $Bytes) { $null = $builder.Append($byte.ToString('x2')) }
    return $builder.ToString()
}

function Get-FileSha256 {
    param([Parameter(Mandatory)][string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try { return (ConvertTo-HexString ($sha.ComputeHash($stream))) }
        finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}

function Write-PackageChecksum {
    # Standard sha256sum sidecar for a release asset: a single line
    # "<sha256>  <file name>". The file is written as UTF-8 without a BOM and
    # stays next to the asset, outside the package directory, so it never becomes
    # part of the delivered-source fingerprint.
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$Name = ''
    )

    $full = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Missing file for checksum: $full" }
    if (-not $Name) { $Name = [IO.Path]::GetFileName($full) }
    $line = ((Get-FileSha256 $full).ToLowerInvariant()) + '  ' + $Name + [char]10
    $target = $full + '.sha256'
    [IO.File]::WriteAllText($target, $line, (New-Object Text.UTF8Encoding($false)))
    return $target
}

function Get-PackageSourceFingerprint {
    param([Parameter(Mandatory)][string]$Root)

    # Stable digest over the delivered source set: ordinal-sorted relative paths,
    # each paired with the SHA-256 of its bytes. Path moves and content edits both
    # change the fingerprint; dependencies, bundled runtimes, tests and bytecode do not.
    $rootPath = ([IO.Path]::GetFullPath($Root)).TrimEnd('\')
    $files = Get-PackageSourceFiles -Root $rootPath
    $manifest = New-Object Text.StringBuilder
    $bytes = [long]0
    foreach ($relative in $files) {
        $path = Get-PackageSourceFilePath -Root $rootPath -RelativePath $relative
        $null = $manifest.Append($relative).Append("`0").Append((Get-FileSha256 $path)).Append("`n")
        $bytes += (Get-Item -LiteralPath $path).Length
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $payload = [Text.Encoding]::UTF8.GetBytes($manifest.ToString())
        return [pscustomobject]@{
            Fingerprint = (ConvertTo-HexString ($sha.ComputeHash($payload)))
            Files = $files.Count
            FileList = $files
            Bytes = $bytes
        }
    } finally { $sha.Dispose() }
}

function Get-GitWorkingTreeState {
    param([Parameter(Mandatory)][string]$ProjectRoot)

    # Working-tree state relative to the build commit. dirtyFiles lists only
    # project-relative paths of delivered source; untracked audit or data files that
    # never enter the package are ignored. Without a usable repository the state stays
    # honestly unknown instead of claiming a clean tree.
    $state = [pscustomobject]@{ Commit = 'unknown'; Dirty = $null; DirtyFiles = @() }
    $git = Get-Command 'git.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $git) { return $state }
    $root = [IO.Path]::GetFullPath($ProjectRoot)
    $commit = ''
    $prefix = ''
    $status = @()
    try {
        # git.exe writes diagnostics to stderr; with a strict error preference that would
        # abort the caller, so a missing repository simply leaves the state unknown.
        $commit = (& $git.Source '-C' $root 'rev-parse' 'HEAD' 2>$null | Out-String).Trim()
        if (-not $commit) { return $state }
        $prefix = (& $git.Source '-C' $root 'rev-parse' '--show-prefix' 2>$null | Out-String).Trim().Replace('\', '/')
        $status = @(& $git.Source '-C' $root 'status' '--porcelain=v1' '--untracked-files=all' 2>$null)
    } catch {
        return $state
    }
    $dirtyFiles = New-Object System.Collections.Generic.List[string]
    foreach ($line in $status) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $entry = $line.Substring(3).Trim()
        if (-not $entry) { continue }
        if ($entry -match ' -> ') { $entry = ($entry -split ' -> ')[-1].Trim() }
        $entry = $entry.Trim('"').Replace('\', '/')
        if ($prefix) {
            if (-not $entry.StartsWith($prefix, [StringComparison]::Ordinal)) { continue }
            $entry = $entry.Substring($prefix.Length)
        }
        if (Test-PackageSourceRelativePath $entry) { $dirtyFiles.Add($entry) }
    }
    $state.Commit = $commit
    $state.Dirty = ($dirtyFiles.Count -gt 0)
    $sorted = $dirtyFiles.ToArray()
    [Array]::Sort($sorted, [StringComparer]::Ordinal)
    $state.DirtyFiles = $sorted
    return $state
}

function New-PackageManifest {
    param(
        [Parameter(Mandatory)][string]$Stage,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$NodeVersion,
        [Parameter(Mandatory)][string]$PythonVersion,
        [Parameter(Mandatory)][int]$PythonMajor,
        [Parameter(Mandatory)][int]$PythonMinor,
        [pscustomobject]$GitState,
        [pscustomobject]$SourceFingerprint
    )

    # Release identity plus traceability: the build commit, the working-tree state at
    # build time and a stable fingerprint of the delivered source. A dirty tree is
    # recorded as dirty instead of being presented as a reproducible clean commit.
    if (-not $SourceFingerprint) { $SourceFingerprint = Get-PackageSourceFingerprint -Root $Stage }
    $commit = 'unknown'
    $dirty = $null
    $dirtyFiles = @()
    if ($GitState) {
        if ($GitState.Commit) { $commit = $GitState.Commit }
        $dirty = $GitState.Dirty
        $dirtyFiles = @($GitState.DirtyFiles)
    }
    return [ordered]@{
        package = 'Go-Antigravity'
        version = $Version
        platform = 'windows-x64'
        commit = $commit
        dirty = $dirty
        dirtyFiles = $dirtyFiles
        source = [ordered]@{
            fingerprint = $SourceFingerprint.Fingerprint
            fileCount = $SourceFingerprint.Files
            files = @($SourceFingerprint.FileList)
            bytes = $SourceFingerprint.Bytes
            scope = 'delivered application source: backend without node_modules and runtime, desktop-qt without tests and __pycache__, and the packaged root documents; the root THIRD-PARTY-NOTICES.md copy and backend/THIRD-PARTY-NOTICES.md are recorded as the two delivered paths they are, and the source side reads the former from the latter; bundled runtimes, npm dependencies, the built launcher and this manifest are excluded'
        }
        builtAt = [DateTime]::UtcNow.ToString('o')
        launcher = 'Go-Antigravity.exe'
        dataDirectory = '%LOCALAPPDATA%\Go-Antigravity'
        node = [ordered]@{ version = $NodeVersion; executable = 'runtime/node/node.exe' }
        python = [ordered]@{ version = $PythonVersion; executable = 'runtime/python/pythonw.exe'; importPath = "runtime/python/python$PythonMajor$PythonMinor._pth" }
        backend = [ordered]@{ entry = 'backend/server.js'; dependencies = 'backend/node_modules' }
        # Update metadata for the desktop client: the stable channel and the release
        # asset it downloads. The updater keeps its own repository constant, so this
        # block is additive metadata for humans and tooling.
        update = [ordered]@{
            repository = 'cooleava1-gif/Go-Antigravity'
            channel = 'stable'
            asset = 'Go-Antigravity-windows-x64.zip'
        }
    }
}
