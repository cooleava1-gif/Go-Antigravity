# Behaviour tests for scripts/build-portable-exe.ps1 and the self-extracting stub in
# desktop-qt/sfx.cs: the EXE must carry the verified ZIP byte-for-byte, unpack it on first run,
# replace an older unpacked folder, and refuse a truncated payload instead of silently starting.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Assert-That([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Portable EXE test failed: $Message" }
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
$null = New-Item -ItemType Directory -Path $temp
try {
    $stage = Join-Path $temp 'stage/Go-Antigravity-windows-x64'
    $null = New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') -Force
    $manifest = @{ package = 'Go-Antigravity'; platform = 'windows-x64'; version = '1.2.3'; commit = 'abc1234' } | ConvertTo-Json
    Set-Content -LiteralPath (Join-Path $stage 'runtime/manifest.json') -Value $manifest -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $stage 'Go-Antigravity.exe') -Value 'launcher placeholder' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $stage 'Start-Go-Antigravity.ps1') -Value '# placeholder' -Encoding ASCII
    $zip = Join-Path $temp 'Go-Antigravity-windows-x64.zip'
    Compress-Archive -Path $stage -DestinationPath $zip -Force

    $output = Join-Path $temp 'out'
    & (Join-Path $PSScriptRoot 'build-portable-exe.ps1') -PackageZip $zip -OutputDirectory $output
    $exe = Join-Path $output 'Go-Antigravity-windows-x64.exe'
    Assert-That (Test-Path -LiteralPath $exe -PathType Leaf) 'the portable EXE was not created'
    Assert-That ((Get-Item -LiteralPath $exe).Length -gt (Get-Item -LiteralPath $zip).Length) 'the portable EXE does not carry the payload'
    Assert-That ([Diagnostics.FileVersionInfo]::GetVersionInfo($exe).FileVersion -eq '1.2.3.0') 'the portable EXE lost the package version'

    $target = Join-Path $temp 'unpacked'
    $first = Start-Process -FilePath $exe -ArgumentList @('--extract-only', '--force', '--quiet', '--target', $target) -Wait -PassThru
    Assert-That ($first.ExitCode -eq 0) "unpacking exited with $($first.ExitCode)"
    $unpackedManifest = Join-Path $target 'runtime/manifest.json'
    Assert-That (Test-Path -LiteralPath $unpackedManifest -PathType Leaf) 'the payload was not unpacked'
    Assert-That ((Get-Content -Raw -LiteralPath $unpackedManifest) -like '*1.2.3*') 'the unpacked manifest lost the version'
    Assert-That (Test-Path -LiteralPath (Join-Path $target 'Go-Antigravity.exe') -PathType Leaf) 'the unpacked launcher is missing'

    # A matching install is reused instead of being unpacked again: the marker file must survive.
    $marker = Join-Path $target 'marker.txt'
    Set-Content -LiteralPath $marker -Value 'kept' -Encoding ASCII
    $second = Start-Process -FilePath $exe -ArgumentList @('--extract-only', '--quiet', '--target', $target) -Wait -PassThru
    Assert-That ($second.ExitCode -eq 0) "the reuse run exited with $($second.ExitCode)"
    Assert-That (Test-Path -LiteralPath $marker -PathType Leaf) 'a matching install was unpacked again instead of being reused'

    # An older install is replaced in place.
    $stale = Get-Content -Raw -LiteralPath $unpackedManifest | ConvertFrom-Json
    $stale.version = '1.0.0'
    $stale | ConvertTo-Json | Set-Content -LiteralPath $unpackedManifest -Encoding UTF8
    $third = Start-Process -FilePath $exe -ArgumentList @('--extract-only', '--quiet', '--target', $target) -Wait -PassThru
    Assert-That ($third.ExitCode -eq 0) "the upgrade run exited with $($third.ExitCode)"
    Assert-That ((Get-Content -Raw -LiteralPath $unpackedManifest) -like '*1.2.3*') 'an older install was not replaced'
    Assert-That (-not (Test-Path -LiteralPath $marker)) 'the replaced install kept stale files'

    # A truncated download must fail loudly instead of starting a half package.
    $broken = Join-Path $temp 'broken.exe'
    $bytes = [IO.File]::ReadAllBytes($exe)
    # Cut the last 512 bytes: the PE stays intact, the ZIP end record is gone.
    $keep = [math]::Max(1024, $bytes.Length - 512)
    [IO.File]::WriteAllBytes($broken, $bytes[0..($keep - 1)])
    $fourth = Start-Process -FilePath $broken -ArgumentList @('--extract-only', '--quiet', '--target', (Join-Path $temp 'broken')) -Wait -PassThru
    Assert-That ($fourth.ExitCode -ne 0) 'a truncated portable EXE still reported success'
    Write-Host 'Portable EXE tests passed.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
