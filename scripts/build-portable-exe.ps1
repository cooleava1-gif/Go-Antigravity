# Build the single-file portable release EXE.
#
# The verified release ZIP is appended to the self-extracting stub in desktop-qt/sfx.cs, so the
# published release is one download: running the EXE unpacks Go-Antigravity-windows-x64 next to
# itself and starts the packaged launcher. The payload stays a plain ZIP appended to the PE, which
# keeps it byte-identically verifiable and lets the desktop updater extract it without executing it.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackageZip,
    [string]$OutputDirectory,
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'dist' }

function Fail([string]$Message) {
    throw "Portable EXE build failed: $Message"
}

function Get-RegionHash([string]$Path, [long]$Offset) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try {
        $null = $stream.Seek($Offset, [IO.SeekOrigin]::Begin)
        $buffer = New-Object byte[] 1048576
        while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $null = $sha.TransformBlock($buffer, 0, $count, $buffer, 0)
        }
        $null = $sha.TransformFinalBlock($buffer, 0, 0)
        return ([BitConverter]::ToString($sha.Hash) -replace '-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

$zip = [IO.Path]::GetFullPath($PackageZip)
if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) { Fail "missing release ZIP: $zip" }
if ((Split-Path -Leaf $zip) -ne 'Go-Antigravity-windows-x64.zip') {
    Fail "the release ZIP must be named Go-Antigravity-windows-x64.zip, got '$(Split-Path -Leaf $zip)'"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
if (-not $Version) {
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        # Windows PowerShell 5.1 writes ZIP entry names with backslashes; accept both separators.
        $entry = @($archive.Entries | Where-Object { ($_.FullName -replace '\\', '/') -eq 'Go-Antigravity-windows-x64/runtime/manifest.json' })
        if ($entry.Count -ne 1) { Fail 'the release ZIP must contain exactly one runtime/manifest.json' }
        $reader = New-Object IO.StreamReader($entry[0].Open())
        try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    } finally {
        $archive.Dispose()
    }
    $Version = [string]$manifest.version
}
if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$') {
    Fail "package version '$Version' is not a semantic version"
}
$fileVersion = ($Version -split '[-+]')[0] + '.0'

$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe'
}
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { Fail '.NET Framework C# compiler not found' }

$stubSource = Join-Path $projectRoot 'desktop-qt/sfx.cs'
$icon = Join-Path $projectRoot 'desktop-qt/assets/go-antigravity.ico'
foreach ($required in @($stubSource, $icon)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { Fail "missing $required" }
}

$null = New-Item -ItemType Directory -Path $OutputDirectory -Force
$output = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'Go-Antigravity-windows-x64.exe'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
$null = New-Item -ItemType Directory -Path $temporary
try {
    $stub = Join-Path $temporary 'stub.exe'
    $source = Join-Path $temporary 'sfx.cs'
    # csc reads the source with the system code page unless it starts with a BOM, so the UTF-8
    # stub (it has Chinese UI text) has to be re-written with an explicit BOM.
    $code = Get-Content -Raw -LiteralPath $stubSource -Encoding UTF8
    $code = $code -replace 'AssemblyVersion\("[^"]+"\)', ('AssemblyVersion("' + $fileVersion + '")')
    $code = $code -replace 'AssemblyFileVersion\("[^"]+"\)', ('AssemblyFileVersion("' + $fileVersion + '")')
    [IO.File]::WriteAllText($source, $code, (New-Object Text.UTF8Encoding($true)))
    & $csc /nologo /target:winexe /optimize+ ('/win32icon:' + $icon) /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll ('/out:' + $stub) $source
    if ($LASTEXITCODE -ne 0) { Fail 'the self-extracting stub did not compile' }
    if (-not (Test-Path -LiteralPath $stub -PathType Leaf)) { Fail 'the self-extracting stub was not produced' }

    if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
    Copy-Item -LiteralPath $stub -Destination $output -Force
    $stubLength = (Get-Item -LiteralPath $stub).Length

    $appending = [IO.File]::Open($output, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $payload = [IO.File]::OpenRead($zip)
        try { $payload.CopyTo($appending, 1048576) } finally { $payload.Dispose() }
    } finally {
        $appending.Dispose()
    }

    $expected = $stubLength + (Get-Item -LiteralPath $zip).Length
    $actual = (Get-Item -LiteralPath $output).Length
    if ($actual -ne $expected) { Fail "the portable EXE is $actual bytes, expected $expected" }
    $header = New-Object byte[] 2
    $readerStream = [IO.File]::OpenRead($output)
    try { $null = $readerStream.Read($header, 0, 2) } finally { $readerStream.Dispose() }
    if ($header[0] -ne 0x4D -or $header[1] -ne 0x5A) { Fail 'the portable EXE does not start with an MZ header' }
    $zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    $payloadHash = Get-RegionHash $output $stubLength
    if ($payloadHash -ne $zipHash) { Fail 'the appended payload is not byte-identical to the verified release ZIP' }
    $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($output)
    if ($versionInfo.FileVersion -ne $fileVersion) {
        Fail "the portable EXE reports file version '$($versionInfo.FileVersion)', expected '$fileVersion'"
    }
    Write-Host "Embedded payload SHA-256: $payloadHash"
    Write-Host "Created $output"
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
