function Test-PackageForbiddenRelativePath {
    param([Parameter(Mandatory)][string]$RelativePath)

    # Check components too: a recursive source walk also visits descendants of excluded directories.
    if ($RelativePath -match '(^|[\\/])(?:\.git|\.go-antigravity-data|\.cloudflared|\.dsh-ops|\.runtime|__pycache__|\.qa|test|backups|_attic)([\\/]|$)') { return $true }
    $name = [IO.Path]::GetFileName($RelativePath.Replace('/', '\'))
    if ($name -match '^\.env(?:\.|$)|^cert\.pem$|^cloudflared.*\.ya?ml$|credentials.*\.json(?:\.|$)|vault.*\.json(?:\.|$)') { return $true }
    if ($name -match '^(accounts|settings|permission-session|danger-rules)(?:\.json(?:\.|$)|[-_.].*\.json$)') { return $true }
    return $name -match '(?:\.log(?:\.|$)|\.bak(?:[-.]|$)|\.old_run(?:\.|$)|\.tmp(?:\.|$)|\.recovery(?:[-.]|$)|\.goagy-context\.json$|~$)'
}

function Get-PackageForbiddenItems {
    param([Parameter(Mandatory)][string]$Root)

    $rootPath = ([IO.Path]::GetFullPath($Root)).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) { throw "Missing package directory: $rootPath" }
    return @(Get-ChildItem -LiteralPath $rootPath -Recurse -Force -ErrorAction Stop | Where-Object {
        $relative = $_.FullName.Substring($rootPath.Length).TrimStart('\', '/')
        Test-PackageForbiddenRelativePath $relative
    })
}
