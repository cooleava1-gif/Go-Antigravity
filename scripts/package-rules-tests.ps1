# Synthetic paths only. Check each expected match as well as legitimate files that must ship.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package-rules.ps1')
. (Join-Path $PSScriptRoot 'package-source.ps1')
$forbidden = @(
    'backend/.env', 'desktop-qt/.env.production', 'backend/.cloudflared/tunnel.yml', 'cert.pem',
    'cloudflared-private.yaml', 'backend/private-credentials-01.json', 'accounts.bak-20261119.json',
    'backend/mobile-vault.json', 'backend/settings.json.123.0e608350-0000-0000-0000-000000000000.tmp',
    'backend/permission-session.json.123.tmp', 'backend/danger-rules-20261119.json', 'backend/engine.exe.old_run',
    'backend/node_modules/pkg/.cloudflared/config.yml', 'backend/secrets.log.previous'
)
foreach ($name in $forbidden) { if (-not (Test-PackageForbiddenRelativePath $name)) { throw "Missed $name" } }
foreach ($name in @('backend/core/settings.js', 'backend/core/vault.js', 'backend/mobile/quick-config.yml', 'runtime/manifest.json', 'backend/node_modules/ws/index.js')) {
    if (Test-PackageForbiddenRelativePath $name) { throw "Unexpected exclusion: $name" }
}
Write-Host 'Windows package exclusion rules passed'

# Source-set rules: the delivered source fingerprint must cover exactly the copied application source.
$sourceIncluded = @(
    'README.md', 'PORTABLE.md', 'LICENSE', 'MOBILE-ACCESS.md', 'Start-Go-Antigravity.ps1', 'Start-Go-Antigravity.cmd',
    'THIRD-PARTY-NOTICES.md', 'backend/server.js', 'backend/package.json', 'backend/package-lock.json',
    'backend/core/agcred.js', 'backend/mobile/tunnel.mjs', 'desktop-qt/main.py', 'desktop-qt/runtime.py',
    'desktop-qt/assets/go-antigravity.ico', 'desktop-qt/requirements.txt'
)
$sourceExcluded = @(
    'backend/node_modules/ws/index.js', 'runtime/manifest.json', 'runtime/node/node.exe',
    'desktop-qt/__pycache__/main.cpython-312.pyc', 'desktop-qt/test_ui.py', 'desktop-qt/smoke_test.py',
    'backend/test/server.test.cjs', '.git/config', '.venv-qt/pyvenv.cfg', 'docs/audit-2026-11-20/REPORT.md',
    '.go-antigravity-data/accounts.json', 'Go-Antigravity.exe'
)
foreach ($name in $sourceIncluded) { if (-not (Test-PackageSourceRelativePath $name)) { throw "Source rule dropped delivered file: $name" } }
foreach ($name in $sourceExcluded) { if (Test-PackageSourceRelativePath $name) { throw "Source rule kept non-delivered file: $name" } }
Write-Host 'Windows package source-set rules passed'
