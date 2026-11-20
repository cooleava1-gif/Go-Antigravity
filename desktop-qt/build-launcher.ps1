param(
    [string]$OutputPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'Go-Antigravity.exe'),
    [string]$Version = ''
)
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe'
}
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw '.NET Framework C# compiler not found.' }
if (-not $Version) {
    $package = Get-Content -Raw -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'backend/package.json') | ConvertFrom-Json
    $Version = [string]$package.version
}
if ($Version -notmatch '^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$') {
    throw 'Launcher Version must be a semantic version such as 1.1.0.'
}
$parts = @($Matches[1], $Matches[2], $Matches[3])
foreach ($part in $parts) {
    if ([decimal]$part -gt 65534) { throw 'Launcher version components must be at most 65534.' }
}
$fileVersion = ($parts -join '.') + '.0'
$source = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'launcher.cs')
$source = $source -replace 'AssemblyVersion\("[^"]+"\)', ('AssemblyVersion("' + $fileVersion + '")')
$source = $source -replace 'AssemblyFileVersion\("[^"]+"\)', ('AssemblyFileVersion("' + $fileVersion + '")')
$temporary = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName() + '.cs')
try {
    Set-Content -LiteralPath $temporary -Value $source -Encoding UTF8
    & $csc /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll (('/win32icon:' + (Join-Path $PSScriptRoot 'assets/go-antigravity.ico'))) ('/out:' + $OutputPath) $temporary
    if ($LASTEXITCODE -ne 0) { throw 'Native launcher build failed.' }
} finally {
    Remove-Item -LiteralPath $temporary -ErrorAction SilentlyContinue
}
Write-Host "Built Go-Antigravity.exe $fileVersion"
