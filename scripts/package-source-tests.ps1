# Delivered-source fingerprint, git working-tree state and release manifest contract.
# Synthetic fixtures only: no real package build, no real account or user data.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package-source.ps1')

$script:passed = 0
$script:base = Join-Path ([IO.Path]::GetTempPath()) ('go-antigravity-source-test-' + [guid]::NewGuid())

function Test-Case([string]$Name, [scriptblock]$Body) {
    & $Body
    $script:passed++
    Write-Host ("PASS $Name")
}
function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-False($Value, [string]$Message) { if ($Value) { throw $Message } }
function Assert-Equal($Expected, $Actual, [string]$Message) {
    if ($Expected -cne $Actual) { throw "$Message (expected '$Expected', got '$Actual')" }
}

function New-Stage {
    param([string]$Name)
    $root = Join-Path $script:base $Name
    foreach ($directory in @('backend', 'backend/core', 'backend/node_modules/ws', 'backend/runtime/node', 'desktop-qt', 'desktop-qt/__pycache__', 'runtime')) {
        $null = New-Item -ItemType Directory -Path (Join-Path $root $directory) -Force
    }
    foreach ($document in (Get-PackageSourceTopLevelFiles)) {
        Set-Content -LiteralPath (Join-Path $root ($document.Replace('/', '\'))) -Value "synthetic $document"
    }
    Set-Content -LiteralPath (Join-Path $root 'backend/server.js') -Value 'synthetic server'
    Set-Content -LiteralPath (Join-Path $root 'backend/package.json') -Value '{"version":"1.0.0"}'
    Set-Content -LiteralPath (Join-Path $root 'backend/core/settings.js') -Value 'synthetic settings'
    Set-Content -LiteralPath (Join-Path $root 'backend/node_modules/ws/index.js') -Value 'third-party dependency'
    Set-Content -LiteralPath (Join-Path $root 'backend/runtime/node/node.exe') -Value 'bundled runtime'
    Set-Content -LiteralPath (Join-Path $root 'desktop-qt/main.py') -Value 'synthetic main'
    Set-Content -LiteralPath (Join-Path $root 'desktop-qt/updater.py') -Value 'synthetic updater'
    Set-Content -LiteralPath (Join-Path $root 'desktop-qt/update_install.ps1') -Value 'synthetic installer'
    Set-Content -LiteralPath (Join-Path $root 'desktop-qt/update_ui.py') -Value 'synthetic update ui'
    Set-Content -LiteralPath (Join-Path $root 'desktop-qt/test_ui.py') -Value 'synthetic test'
    Set-Content -LiteralPath (Join-Path $root 'desktop-qt/smoke_test.py') -Value 'synthetic smoke'
    Set-Content -LiteralPath (Join-Path $root 'desktop-qt/__pycache__/main.pyc') -Value 'bytecode'
    return $root
}

try {
    $null = New-Item -ItemType Directory -Path $script:base -Force

    Test-Case 'fingerprint is stable across an identical copy' {
        $stage = New-Stage 'copy-source'
        $copy = Join-Path $script:base 'copy-target'
        Copy-Item -LiteralPath $stage -Destination $copy -Recurse -Force
        $first = Get-PackageSourceFingerprint -Root $stage
        $second = Get-PackageSourceFingerprint -Root $copy
        Assert-Equal $first.Fingerprint $second.Fingerprint 'Copied source must keep the same fingerprint'
        Assert-True ($first.Files -gt 0) 'Fingerprint covered no files'
    }

    Test-Case 'fingerprint changes when delivered source changes' {
        $stage = New-Stage 'content'
        $before = Get-PackageSourceFingerprint -Root $stage
        Set-Content -LiteralPath (Join-Path $stage 'backend/core/settings.js') -Value 'tampered settings'
        $after = Get-PackageSourceFingerprint -Root $stage
        Assert-False ($before.Fingerprint -ceq $after.Fingerprint) 'Source change did not change the fingerprint'
    }

    Test-Case 'fingerprint ignores dependencies, bundled runtimes, tests and bytecode' {
        $stage = New-Stage 'excluded'
        $before = Get-PackageSourceFingerprint -Root $stage
        Set-Content -LiteralPath (Join-Path $stage 'backend/node_modules/ws/index.js') -Value 'tampered dependency'
        Set-Content -LiteralPath (Join-Path $stage 'backend/runtime/node/node.exe') -Value 'tampered runtime'
        Set-Content -LiteralPath (Join-Path $stage 'desktop-qt/test_ui.py') -Value 'tampered test'
        Set-Content -LiteralPath (Join-Path $stage 'desktop-qt/smoke_test.py') -Value 'tampered smoke'
        Set-Content -LiteralPath (Join-Path $stage 'desktop-qt/__pycache__/main.pyc') -Value 'tampered bytecode'
        $after = Get-PackageSourceFingerprint -Root $stage
        Assert-Equal $before.Fingerprint $after.Fingerprint 'Non-delivered content changed the fingerprint'
    }

    Test-Case 'fingerprint notices added and removed source files' {
        $stage = New-Stage 'layout'
        $before = Get-PackageSourceFingerprint -Root $stage
        Set-Content -LiteralPath (Join-Path $stage 'backend/core/new-feature.js') -Value 'new source'
        Assert-False ($before.Fingerprint -ceq (Get-PackageSourceFingerprint -Root $stage).Fingerprint) 'Added source file did not change the fingerprint'
        Remove-Item -LiteralPath (Join-Path $stage 'backend/server.js') -Force
        Assert-False ($before.Fingerprint -ceq (Get-PackageSourceFingerprint -Root $stage).Fingerprint) 'Removed source file did not change the fingerprint'
    }

    Test-Case 'the copied notices document is delivered under both of its paths' {
        # Project layout: the document only exists under backend/.
        $projectLike = New-Stage 'copy-map-project'
        Remove-Item -LiteralPath (Join-Path $projectLike 'THIRD-PARTY-NOTICES.md') -Force
        Set-Content -LiteralPath (Join-Path $projectLike 'backend/THIRD-PARTY-NOTICES.md') -Value 'third-party notices'
        # Stage layout: the package root carries a copy while the backend tree also has it.
        $stage = New-Stage 'copy-map-stage'
        Set-Content -LiteralPath (Join-Path $stage 'THIRD-PARTY-NOTICES.md') -Value 'third-party notices'
        Set-Content -LiteralPath (Join-Path $stage 'backend/THIRD-PARTY-NOTICES.md') -Value 'third-party notices'
        $first = Get-PackageSourceFingerprint -Root $projectLike
        $second = Get-PackageSourceFingerprint -Root $stage
        Assert-Equal $first.Fingerprint $second.Fingerprint 'The copied notices document broke fingerprint equality'
        Assert-Equal 1 @($first.FileList | Where-Object { $_ -eq 'THIRD-PARTY-NOTICES.md' }).Count 'Root notices copy is not recorded'
        Assert-Equal 1 @($first.FileList | Where-Object { $_ -eq 'backend/THIRD-PARTY-NOTICES.md' }).Count 'Backend notices document is not recorded'
    }

    Test-Case 'a tampered root notices copy changes the fingerprint' {
        $stage = New-Stage 'copy-map-tamper'
        Set-Content -LiteralPath (Join-Path $stage 'backend/THIRD-PARTY-NOTICES.md') -Value 'third-party notices'
        Set-Content -LiteralPath (Join-Path $stage 'THIRD-PARTY-NOTICES.md') -Value 'third-party notices'
        $before = Get-PackageSourceFingerprint -Root $stage
        Set-Content -LiteralPath (Join-Path $stage 'THIRD-PARTY-NOTICES.md') -Value 'tampered notices'
        $after = Get-PackageSourceFingerprint -Root $stage
        Assert-False ($before.Fingerprint -ceq $after.Fingerprint) 'Tampering with the root notices copy went undetected'
    }


    Test-Case 'verify fails when the package lost the root notices copy' {
        # Package-shaped stage: the root copy and the backend original carry identical
        # bytes, so removing the root copy alone cannot change the fingerprint.
        $stage = Join-Path $script:base 'verify-notices'
        foreach ($directory in @('backend', 'desktop-qt', 'runtime')) {
            $null = New-Item -ItemType Directory -Path (Join-Path $stage $directory) -Force
        }
        foreach ($document in (Get-PackageSourceTopLevelFiles)) {
            Set-Content -LiteralPath (Join-Path $stage ($document.Replace('/', '\\'))) -Value "package $document"
        }
        Set-Content -LiteralPath (Join-Path $stage 'THIRD-PARTY-NOTICES.md') -Value 'third-party notices'
        Set-Content -LiteralPath (Join-Path $stage 'backend/THIRD-PARTY-NOTICES.md') -Value 'third-party notices'
        Set-Content -LiteralPath (Join-Path $stage 'backend/server.js') -Value 'server'
        Set-Content -LiteralPath (Join-Path $stage 'desktop-qt/main.py') -Value 'main'
        $manifest = New-PackageManifest -Stage $stage -Version '1.2.3' -NodeVersion 'v24.18.0' -PythonVersion '3.12.10' -PythonMajor 3 -PythonMinor 12
        Set-Content -LiteralPath (Join-Path $stage 'runtime/manifest.json') -Value ($manifest | ConvertTo-Json -Depth 6)
        $verify = Join-Path $PSScriptRoot 'verify-package-source.ps1'
        $null = & $verify -PackagePath $stage
        Remove-Item -LiteralPath (Join-Path $stage 'THIRD-PARTY-NOTICES.md') -Force
        $failed = $false
        try { $null = & $verify -PackagePath $stage } catch { $failed = $true }
        Assert-True $failed 'Losing the packaged root notices copy still verified as matching'
    }

    Test-Case 'manifest records the working tree and the stage fingerprint' {
        $stage = New-Stage 'manifest'
        $gitState = [pscustomobject]@{
            Commit = '0123456789abcdef0123456789abcdef01234567'
            Dirty = $true
            DirtyFiles = @('README.md', 'backend/core/settings.js')
        }
        $manifest = New-PackageManifest -Stage $stage -Version '1.2.3' -NodeVersion 'v24.18.0' -PythonVersion '3.12.10' -PythonMajor 3 -PythonMinor 12 -GitState $gitState
        $parsed = ($manifest | ConvertTo-Json -Depth 6) | ConvertFrom-Json
        Assert-Equal 'Go-Antigravity' $parsed.package 'Manifest lost the package identity'
        Assert-Equal 'windows-x64' $parsed.platform 'Manifest lost the platform'
        Assert-Equal '1.2.3' $parsed.version 'Manifest lost the version'
        Assert-Equal $gitState.Commit $parsed.commit 'Manifest lost the build commit'
        Assert-Equal $true $parsed.dirty 'Manifest lost the dirty state'
        Assert-Equal 2 $parsed.dirtyFiles.Count 'Manifest lost the dirty file list'
        Assert-Equal 'README.md' $parsed.dirtyFiles[0] 'Manifest dirty files are not project-relative paths'
        $fingerprint = Get-PackageSourceFingerprint -Root $stage
        Assert-Equal $fingerprint.Fingerprint $parsed.source.fingerprint 'Manifest fingerprint does not match the stage'
        Assert-Equal $fingerprint.Files $parsed.source.fileCount 'Manifest fingerprint file count does not match the stage'
        Assert-Equal $fingerprint.Files @($parsed.source.files).Count 'Manifest source file list does not match the stage'
        Assert-True (@($parsed.source.files) -contains 'backend/server.js') 'Manifest source file list is missing delivered source'
        Assert-False (@($parsed.source.files) -contains 'backend/node_modules/ws/index.js') 'Manifest source file list includes a dependency'
        Assert-Equal 'runtime/node/node.exe' $parsed.node.executable 'Manifest lost the Node runtime path'
        Assert-Equal 'runtime/python/pythonw.exe' $parsed.python.executable 'Manifest lost the Python runtime path'
        Assert-Equal 'runtime/python/python312._pth' $parsed.python.importPath 'Manifest lost the Python import path'
        Assert-Equal 'backend/server.js' $parsed.backend.entry 'Manifest lost the backend entry'
        Assert-Equal '%LOCALAPPDATA%\Go-Antigravity' $parsed.dataDirectory 'Manifest lost the data directory'
    }

    Test-Case 'manifest without git keeps an honest unknown state' {
        $stage = New-Stage 'no-git'
        $manifest = New-PackageManifest -Stage $stage -Version '1.2.3' -NodeVersion 'v24.18.0' -PythonVersion '3.12.10' -PythonMajor 3 -PythonMinor 12
        $parsed = ($manifest | ConvertTo-Json -Depth 6) | ConvertFrom-Json
        Assert-Equal 'unknown' $parsed.commit 'Missing git must not invent a commit'
        Assert-True ($null -eq $parsed.dirty) 'Missing git must not claim a clean tree'
        Assert-Equal 0 $parsed.dirtyFiles.Count 'Missing git must not list dirty files'
    }

    Test-Case 'manifest records the stable update channel' {
        $stage = New-Stage 'update-metadata'
        $manifest = New-PackageManifest -Stage $stage -Version '1.2.3' -NodeVersion 'v24.18.0' -PythonVersion '3.12.10' -PythonMajor 3 -PythonMinor 12
        $parsed = ($manifest | ConvertTo-Json -Depth 6) | ConvertFrom-Json
        Assert-True ($null -ne $parsed.update) 'Manifest lost the update metadata block'
        Assert-Equal 'cooleava1-gif/Go-Antigravity' $parsed.update.repository 'Manifest update repository is wrong'
        Assert-Equal 'stable' $parsed.update.channel 'Manifest update channel is wrong'
        Assert-Equal 'Go-Antigravity-windows-x64.exe' $parsed.update.asset 'Manifest update asset is wrong'
    }

    Test-Case 'the desktop updater scripts are delivered source' {
        $stage = New-Stage 'updater-source'
        $files = @(Get-PackageSourceFiles -Root $stage)
        foreach ($delivered in @('desktop-qt/updater.py', 'desktop-qt/update_install.ps1', 'desktop-qt/update_ui.py')) {
            Assert-True ($files -contains $delivered) "Delivered source is missing $delivered"
            Assert-True (Test-PackageSourceRelativePath $delivered) "$delivered must stay delivered source"
        }
        Assert-False (Test-PackageSourceRelativePath 'desktop-qt/test_updater.py') 'Tests must not be delivered source'
        $fingerprint = Get-PackageSourceFingerprint -Root $stage
        Assert-True (@($fingerprint.FileList) -contains 'desktop-qt/updater.py') 'The updater is not part of the fingerprint'
    }

    Test-Case 'the checksum sidecar uses the standard sha256sum format' {
        $stage = New-Stage 'checksum'
        $asset = Join-Path $stage 'Go-Antigravity-windows-x64.zip'
        [IO.File]::WriteAllBytes($asset, [byte[]](0x50, 0x4b, 0x03, 0x04, 0x00, 0x01))
        $written = Write-PackageChecksum -Path $asset
        Assert-Equal ($asset + '.sha256') $written 'The checksum sidecar was written to an unexpected path'
        $bytes = [IO.File]::ReadAllBytes($written)
        $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
        Assert-False $hasBom 'The checksum sidecar must not start with a BOM'
        $text = [Text.Encoding]::UTF8.GetString($bytes)
        Assert-True ($text -match '^[0-9a-f]{64}  [^\r\n]+\r?\n$') 'The checksum sidecar is not a standard sha256sum line'
        Assert-Equal (Get-FileSha256 $asset) ($text -split '\s+')[0] 'The checksum sidecar does not match the asset'
    }

    $git = Get-Command 'git.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $git) {
        Write-Host 'SKIP git working-tree cases: git.exe is unavailable'
    } else {
        function New-GitFixture {
            param([string]$Name)
            $root = Join-Path $script:base $Name
            foreach ($directory in @('backend', 'desktop-qt', 'docs/audit-2026-11-20')) {
                $null = New-Item -ItemType Directory -Path (Join-Path $root $directory) -Force
            }
            foreach ($document in @('README.md', 'PORTABLE.md', 'LICENSE', 'MOBILE-ACCESS.md', 'Start-Go-Antigravity.ps1', 'Start-Go-Antigravity.cmd')) {
                Set-Content -LiteralPath (Join-Path $root $document) -Value "fixture $document"
            }
            Set-Content -LiteralPath (Join-Path $root 'backend/server.js') -Value 'server'
            Set-Content -LiteralPath (Join-Path $root 'backend/THIRD-PARTY-NOTICES.md') -Value 'notices'
            Set-Content -LiteralPath (Join-Path $root 'desktop-qt/main.py') -Value 'main'
            Set-Content -LiteralPath (Join-Path $root 'desktop-qt/test_ui.py') -Value 'test'
            Set-Content -LiteralPath (Join-Path $root 'docs/audit-2026-11-20/REPORT.md') -Value 'audit'
            & git.exe -C $root init -q
            if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
            & git.exe -C $root add -A
            & git.exe -C $root -c user.name='package test' -c user.email='package-test@invalid' -c commit.gpgsign=false commit -q -m 'fixture'
            if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
            return $root
        }

        Test-Case 'clean tree is not reported dirty' {
            $root = New-GitFixture 'git-clean'
            $state = Get-GitWorkingTreeState -ProjectRoot $root
            $head = (& git.exe -C $root 'rev-parse' 'HEAD' | Out-String).Trim()
            Assert-Equal $head $state.Commit 'Commit does not match HEAD'
            Assert-Equal $false $state.Dirty 'Clean tree reported as dirty'
            Assert-Equal 0 $state.DirtyFiles.Count 'Clean tree listed dirty files'
        }

        Test-Case 'modified delivered source marks the tree dirty' {
            $root = New-GitFixture 'git-modified'
            Set-Content -LiteralPath (Join-Path $root 'backend/server.js') -Value 'changed server'
            $state = Get-GitWorkingTreeState -ProjectRoot $root
            Assert-Equal $true $state.Dirty 'Modified delivered source was not detected'
            Assert-True ($state.DirtyFiles -contains 'backend/server.js') 'Modified source missing from the dirty list'
        }

        Test-Case 'non-delivered changes do not mark the package dirty' {
            $root = New-GitFixture 'git-nondelivered'
            Set-Content -LiteralPath (Join-Path $root 'desktop-qt/test_ui.py') -Value 'changed test'
            Set-Content -LiteralPath (Join-Path $root 'docs/audit-2026-11-20/REPORT.md') -Value 'changed audit'
            $state = Get-GitWorkingTreeState -ProjectRoot $root
            Assert-Equal $false $state.Dirty 'Undelivered files marked the package dirty'
            Assert-Equal 0 $state.DirtyFiles.Count 'Undelivered files entered the dirty list'
        }

        Test-Case 'untracked delivered source marks the tree dirty' {
            $root = New-GitFixture 'git-untracked'
            $null = New-Item -ItemType Directory -Path (Join-Path $root 'backend/core') -Force
            Set-Content -LiteralPath (Join-Path $root 'backend/core/new-feature.js') -Value 'new feature'
            $state = Get-GitWorkingTreeState -ProjectRoot $root
            Assert-Equal $true $state.Dirty 'Untracked delivered source was not detected'
            Assert-True ($state.DirtyFiles -contains 'backend/core/new-feature.js') 'Untracked source missing from the dirty list'
        }

        Test-Case 'working tree outside a repository reports unknown' {
            $root = Join-Path $script:base 'not-a-repo'
            $null = New-Item -ItemType Directory -Path $root -Force
            $state = Get-GitWorkingTreeState -ProjectRoot $root
            Assert-Equal 'unknown' $state.Commit 'Non-repo must not report a commit'
            Assert-True ($null -eq $state.Dirty) 'Non-repo must not claim a clean or dirty tree'
        }

        Test-Case 'manifest built from a real dirty tree records the change' {
            $root = New-GitFixture 'git-manifest'
            Set-Content -LiteralPath (Join-Path $root 'backend/server.js') -Value 'changed again'
            $manifest = New-PackageManifest -Stage $root -Version '1.2.3' -NodeVersion 'v24.18.0' -PythonVersion '3.12.10' -PythonMajor 3 -PythonMinor 12 -GitState (Get-GitWorkingTreeState -ProjectRoot $root)
            $parsed = ($manifest | ConvertTo-Json -Depth 6) | ConvertFrom-Json
            Assert-Equal $true $parsed.dirty 'Dirty tree was recorded as clean'
            Assert-True ($parsed.dirtyFiles -contains 'backend/server.js') 'Dirty file list does not match the working tree'
            Assert-Equal (Get-PackageSourceFingerprint -Root $root).Fingerprint $parsed.source.fingerprint 'Manifest fingerprint does not match the tree'
        }
    }

    Write-Host "Windows package source traceability passed ($($script:passed) cases)"
} finally {
    if (Test-Path -LiteralPath $script:base) { Remove-Item -LiteralPath $script:base -Recurse -Force }
}
