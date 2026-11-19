param([string]$OutputPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'Go-Antigravity.exe'))
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe'
}
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw '.NET Framework C# compiler not found.' }
& $csc /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll (('/win32icon:' + (Join-Path $PSScriptRoot 'assets/go-antigravity.ico'))) ('/out:' + $OutputPath) (Join-Path $PSScriptRoot 'launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native launcher build failed.' }
Write-Host 'Built Go-Antigravity.exe'
