# Verify that a copied release package still contains exactly the source its manifest
# recorded. Accepts a package directory or the release ZIP and reuses the safe
# extraction pattern from scripts/package-smoke-test.ps1.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackagePath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package-source.ps1')

function Fail([string]$Message) {
    throw "Package source verification failed: $Message"
}

$source = [IO.Path]::GetFullPath($PackagePath)
if (-not (Test-Path -LiteralPath $source)) { Fail "Missing package path: $source" }

$tempRoot = $null
try {
    if (Test-Path -LiteralPath $source -PathType Container) {
        $root = $source
    } else {
        # Keep Qt's deep bundled paths below Windows PowerShell 5.1's MAX_PATH limit.
        $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
        $null = New-Item -ItemType Directory -Path $tempRoot
        Expand-Archive -LiteralPath $source -DestinationPath $tempRoot
        $entries = @(Get-ChildItem -LiteralPath $tempRoot -Force)
        if ($entries.Count -ne 1 -or -not $entries[0].PSIsContainer -or $entries[0].Name -ne 'Go-Antigravity-windows-x64') {
            Fail "Unexpected ZIP root in $source"
        }
        $root = $entries[0].FullName
    }

    $manifestPath = Join-Path $root 'runtime/manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { Fail "Missing runtime/manifest.json under $root" }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if (-not $manifest.package -or -not $manifest.platform) { Fail 'Manifest is missing the release identity.' }
    if (-not $manifest.source -or -not $manifest.source.fingerprint) { Fail 'Manifest does not record a delivered-source fingerprint.' }

    $forbidden = @(Get-PackageForbiddenItems $root)
    if ($forbidden.Count -gt 0) {
        $names = ($forbidden | Select-Object -First 5 -ExpandProperty FullName) -join '; '
        Fail "forbidden development or user data in the package: $names"
    }

    $recordedFiles = @($manifest.source.files)
    if ($recordedFiles.Count -gt 0) {
        # The fingerprint rules read a missing root notices copy through its backend
        # alias, so a package that lost that physical file would still hash the same
        # bytes. Every recorded delivered file must physically exist before comparing.
        foreach ($recorded in $recordedFiles) {
            $physical = Join-Path $root ($recorded.Replace('/', '\\'))
            if (-not (Test-Path -LiteralPath $physical -PathType Leaf)) {
                Fail "delivered source file is missing from the package: $recorded"
            }
        }
    }

    $actual = Get-PackageSourceFingerprint -Root $root
    if ($actual.Fingerprint -cne $manifest.source.fingerprint) {
        Fail "delivered source fingerprint mismatch: manifest $($manifest.source.fingerprint), package $($actual.Fingerprint)"
    }
    if ($manifest.source.fileCount -and $manifest.source.fileCount -ne $actual.Files) {
        Fail "delivered source file count mismatch: manifest $($manifest.source.fileCount), package $($actual.Files)"
    }
    if ($recordedFiles.Count -gt 0) {
        if ($recordedFiles.Count -ne $actual.FileList.Count -or (Compare-Object -CaseSensitive $recordedFiles $actual.FileList)) {
            Fail 'delivered source file list does not match the manifest'
        }
    }

    Write-Host "Verified delivered source fingerprint $($actual.Fingerprint) ($($actual.Files) files, $($actual.Bytes) bytes)"
    if ($manifest.commit) {
        Write-Host "Manifest commit $($manifest.commit); working tree dirty at build: $($manifest.dirty)"
        if ($manifest.dirtyFiles -and $manifest.dirtyFiles.Count -gt 0) {
            Write-Host "Dirty at build: $($manifest.dirtyFiles -join ', ')"
        }
    }
    Write-Host "Verified package: $root"
} finally {
    if ($tempRoot -and (Test-Path -LiteralPath $tempRoot)) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
