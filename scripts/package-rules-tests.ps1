# Synthetic paths only. Check each expected match as well as legitimate files that must ship.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package-rules.ps1')
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
