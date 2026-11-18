[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist'),
    [string]$Version = '',
    [string]$NodeSource = '',
    [string]$PythonSource = '',
    [string]$PythonEnvironment = '',
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:PackageName = 'Go-Antigravity-windows-x64'

function Fail([string]$Message) {
    throw "Windows package build failed: $Message"
}

function Get-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path)
}

function Test-PathInside([string]$Path, [string]$Parent) {
    $childPath = (Get-FullPath $Path).TrimEnd('\') + '\'
    $parentPath = (Get-FullPath $Parent).TrimEnd('\') + '\'
    return $childPath.StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-File([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Fail "Missing ${Description}: $Path"
    }
}

function Assert-Directory([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        Fail "Missing ${Description}: $Path"
    }
}

function Invoke-Native([string]$Executable, [string[]]$Arguments, [string]$Description) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        Fail "$Description exited with code $LASTEXITCODE"
    }
}

function Resolve-CommandPath([string]$Name) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { return $null }
    return (Get-FullPath $command.Source)
}

function Get-VersionFromExecutable([string]$Executable, [string]$Description) {
    $output = (& $Executable '--version' 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $output) {
        Fail "Could not read $Description version from $Executable"
    }
    return $output
}

function Get-NodeSourcePath {
    param([string]$Requested)
    $candidate = if ($Requested) { Get-FullPath $Requested } else { Resolve-CommandPath 'node.exe' }
    Assert-File $candidate 'Node.js executable'
    $version = Get-VersionFromExecutable $candidate 'Node.js'
    if ($version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        Fail "Node.js 22+ is required; found $version"
    }
    return [pscustomobject]@{ Path = $candidate; Version = $version }
}

function Get-PythonInfo {
    param([string]$Executable)
    $probe = @'
import sys
print(sys.version_info.major)
print(sys.version_info.minor)
print(sys.version_info.micro)
print(sys.base_prefix)
print(sys.prefix)
print(sys.executable)
'@
    $output = (& $Executable '-c' $probe 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { Fail "Could not inspect Python runtime $Executable`n$output" }
    $lines = @($output -split "`r?`n" | Where-Object { $_ -ne '' } | ForEach-Object { $_.Trim() })
    if ($lines.Count -lt 6) { Fail "Python runtime inspection returned incomplete output: $output" }
    $info = [pscustomobject]@{
        Major = [int]$lines[0]
        Minor = [int]$lines[1]
        Micro = [int]$lines[2]
        Version = "$($lines[0]).$($lines[1]).$($lines[2])"
        BasePrefix = $lines[3]
        Prefix = $lines[4]
        Executable = $lines[5]
    }
    if ($info.Major -lt 3 -or ($info.Major -eq 3 -and $info.Minor -lt 10)) {
        Fail "Python 3.10+ is required; found $($info.Version)"
    }
    return $info
}

function Get-PythonEnvironmentPath {
    param([string]$Requested)
    $candidate = if ($Requested) { Get-FullPath $Requested } else { Join-Path $script:ProjectRoot '.venv-qt' }
    Assert-Directory $candidate 'prepared Python environment'
    $python = Join-Path $candidate 'Scripts/python.exe'
    Assert-File $python 'prepared Python executable'
    $config = Join-Path $candidate 'pyvenv.cfg'
    Assert-File $config 'Python environment metadata'
    $versionLine = Get-Content -LiteralPath $config | Where-Object { $_ -match '^\s*version\s*=\s*(.+)$' } | Select-Object -First 1
    $homeLine = Get-Content -LiteralPath $config | Where-Object { $_ -match '^\s*home\s*=\s*(.+)$' } | Select-Object -First 1
    $versionMatch = if ($versionLine) { [regex]::Match($versionLine, '^\s*version\s*=\s*(\d+)\.(\d+)\.(\d+)') } else { $null }
    $homeMatch = if ($homeLine) { [regex]::Match($homeLine, '^\s*home\s*=\s*(.+)$') } else { $null }
    if (-not $versionMatch -or -not $versionMatch.Success -or -not $homeMatch -or -not $homeMatch.Success) {
        Fail "Python environment metadata is incomplete: $config"
    }
    Get-PythonInfo $python | Out-Null
    $info = [pscustomobject]@{
        Major = [int]$versionMatch.Groups[1].Value
        Minor = [int]$versionMatch.Groups[2].Value
        Micro = [int]$versionMatch.Groups[3].Value
        Version = $versionMatch.Groups[0].Value -replace '^\s*version\s*=\s*', ''
        BasePrefix = $homeMatch.Groups[1].Value.Trim()
        Prefix = $candidate
        Executable = $python
    }
    return [pscustomobject]@{
        Root = $candidate
        Executable = $python
        Major = $info.Major
        Minor = $info.Minor
        Micro = $info.Micro
        Version = $info.Version
        BasePrefix = $info.BasePrefix
        Prefix = $info.Prefix
    }
}

function Copy-FileSafe([string]$Source, [string]$Destination) {
    Assert-File $Source 'source file'
    $parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-TreeFiltered {
    param(
        [string]$Source,
        [string]$Destination,
        [scriptblock]$Include = { param($Item, $Relative) $true }
    )
    Assert-Directory $Source 'source directory'
    $sourceRoot = (Get-FullPath $Source).TrimEnd('\')
    $destinationRoot = Get-FullPath $Destination
    New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force) {
        $relative = $item.FullName.Substring($sourceRoot.Length).TrimStart('\')
        if (-not (& $Include $item $relative)) { continue }
        $target = Join-Path $destinationRoot $relative
        if ($item.PSIsContainer) {
            New-Item -ItemType Directory -Path $target -Force | Out-Null
        } else {
            New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
            Copy-Item -LiteralPath $item.FullName -Destination $target -Force
        }
    }
}

function Should-CopyDesktopItem {
    param($Item, [string]$Relative)
    if ($Relative -match '(^|[\\/])(__pycache__|\.qa)([\\/]|$)') { return $false }
    if (-not $Item.PSIsContainer -and ($Item.Name -match '^(test_.*|smoke_test)\.py$')) { return $false }
    return $true
}

function Should-CopyBackendItem {
    param($Item, [string]$Relative)
    if ($Relative -match '(^|[\\/])(test|node_modules|runtime|\.runtime|backups|_attic)([\\/]|$)') { return $false }
    if ($Relative -match '(^|[\\/])(__pycache__|\.git)([\\/]|$)') { return $false }
    if (-not $Item.PSIsContainer -and ($Item.Name -match '(\.log(\..*)?|\.bak|\.old_run)$')) { return $false }
    if (-not $Item.PSIsContainer -and ($Item.Name -match '^(accounts|settings|permission-session|danger-rules)\.json$')) { return $false }
    return $true
}

function Copy-PythonRuntime {
    param(
        [string]$PythonExecutable,
        [string]$PythonEnvironmentRoot,
        [pscustomobject]$Info,
        [string]$Destination
    )
    $base = Split-Path -Parent (Get-FullPath $PythonExecutable)
    Assert-Directory $base 'Python base runtime'
    $envSite = Join-Path $PythonEnvironmentRoot 'Lib/site-packages'
    Assert-Directory $envSite 'prepared Python site-packages'
    Assert-Directory (Join-Path $envSite 'PyQt6') 'PyQt6 package'
    Assert-Directory (Join-Path $envSite 'qrcode') 'qrcode package'

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($pattern in @('python*.exe', 'python*.dll', 'vcruntime*.dll', 'LICENSE.txt')) {
        Get-ChildItem -LiteralPath $base -Filter $pattern -File -ErrorAction SilentlyContinue | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Destination $_.Name) -Force
        }
    }
    Assert-File (Join-Path $Destination 'python.exe') 'copied Python executable'
    Assert-File (Join-Path $Destination 'pythonw.exe') 'copied Python windowed executable'

    Copy-TreeFiltered (Join-Path $base 'DLLs') (Join-Path $Destination 'DLLs') -Include {
        param($Item, $Relative)
        return -not ($Relative -match '(^|[\\/])__pycache__([\\/]|$)')
    }
    Copy-TreeFiltered (Join-Path $base 'Lib') (Join-Path $Destination 'Lib') -Include {
        param($Item, $Relative)
        if ($Relative -match '(^|[\\/])site-packages([\\/]|$)') { return $false }
        if ($Relative -match '(^|[\\/])test([\\/]|$)') { return $false }
        if ($Relative -match '(^|[\\/])__pycache__([\\/]|$)') { return $false }
        return $true
    }
    Copy-TreeFiltered $envSite (Join-Path $Destination 'Lib/site-packages') -Include {
        param($Item, $Relative)
        $top = ($Relative -split '[\\/]')[0]
        if ($top -match '^(pip|setuptools|wheel|_distutils_hack|pkg_resources)(-|$)') { return $false }
        if ($Relative -match '(^|[\\/])__pycache__([\\/]|$)') { return $false }
        return $true
    }

    $tag = "python$($Info.Major)$($Info.Minor)"
    $pth = @(
        'Lib',
        'DLLs',
        'Lib\site-packages',
        '..\..\desktop-qt',
        'import site'
    ) -join "`r`n"
    Set-Content -LiteralPath (Join-Path $Destination "$tag._pth") -Value ($pth + "`r`n") -Encoding ASCII

    $probe = "import PyQt6, qrcode, colorama, sys; assert sys.version_info >= (3,10)"
    Invoke-Native (Join-Path $Destination 'python.exe') @('-B', '-c', $probe) 'bundled Python import check'
}

function Get-NpmCliPath([string]$NodePath) {
    $nodeDirectory = Split-Path -Parent $NodePath
    $candidates = @(Join-Path $nodeDirectory 'node_modules/npm/bin/npm-cli.js')
    $npm = Resolve-CommandPath 'npm.cmd'
    if ($npm) { $candidates += Join-Path (Split-Path -Parent $npm) 'node_modules/npm/bin/npm-cli.js' }
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return (Get-FullPath $candidate) }
    }
    Fail 'npm-cli.js was not found next to Node.js; install Node.js with npm.'
}

function Get-GitCommit {
    $git = Resolve-CommandPath 'git.exe'
    if (-not $git) { return 'unknown' }
    $value = (& $git '-C' $script:ProjectRoot 'rev-parse' '--short' 'HEAD' 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $value) { return 'unknown' }
    return $value
}

function Get-PackageVersion {
    param([string]$Requested)
    if ($Requested) { return $Requested }
    $manifest = Join-Path $script:ProjectRoot 'backend/package.json'
    Assert-File $manifest 'backend package manifest'
    $package = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if (-not $package.version) { return '0.0.0' }
    return [string]$package.version
}

function Assert-SafeOutput([string]$OutputRoot, [string]$Stage, [string]$Zip) {
    $project = Get-FullPath $script:ProjectRoot
    if ((Get-FullPath $OutputRoot).TrimEnd('\') -eq $project.TrimEnd('\')) { Fail 'OutputDirectory cannot be the project root.' }
    if (-not (Test-PathInside $Stage $OutputRoot)) { Fail 'Stage directory escaped OutputDirectory.' }
    if (-not (Test-PathInside $Zip $OutputRoot)) { Fail 'ZIP path escaped OutputDirectory.' }
    if ((Get-FullPath $Stage).TrimEnd('\') -eq (Get-FullPath $OutputRoot).TrimEnd('\')) { Fail 'Stage directory must be a child of OutputDirectory.' }
}

if (-not [Environment]::Is64BitOperatingSystem) { Fail 'A 64-bit Windows build host is required.' }

$outputRoot = if ([IO.Path]::IsPathRooted($OutputDirectory)) { Get-FullPath $OutputDirectory } else { Get-FullPath (Join-Path $script:ProjectRoot $OutputDirectory) }
$stage = Join-Path $outputRoot $script:PackageName
$zip = Join-Path $outputRoot ($script:PackageName + '.zip')
Assert-SafeOutput $outputRoot $stage $zip

if (Test-Path -LiteralPath $stage) {
    if (-not $Clean) { Fail "Output already exists: $stage. Use -Clean or another OutputDirectory." }
    Remove-Item -LiteralPath $stage -Recurse -Force
}
if (Test-Path -LiteralPath $zip) {
    if (-not $Clean) { Fail "Output already exists: $zip. Use -Clean or another OutputDirectory." }
    Remove-Item -LiteralPath $zip -Force
}
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

$requiredFiles = @(
    'Start-Go-Antigravity.ps1', 'Start-Go-Antigravity.cmd', 'desktop-qt/build-launcher.ps1',
    'desktop-qt/launcher.cs', 'desktop-qt/main.py', 'desktop-qt/runtime.py',
    'desktop-qt/backend_client.py', 'desktop-qt/account_tools.py', 'desktop-qt/theme.py',
    'desktop-qt/ui.py', 'desktop-qt/widgets.py', 'desktop-qt/assets/go-antigravity.ico',
    'backend/server.js', 'backend/package.json', 'backend/package-lock.json',
    'backend/NODE-LICENSE.txt', 'backend/THIRD-PARTY-NOTICES.md', 'LICENSE', 'PORTABLE.md'
)
foreach ($relative in $requiredFiles) { Assert-File (Join-Path $script:ProjectRoot $relative) $relative }

$node = Get-NodeSourcePath $NodeSource
$preparedPythonRoot = if ($PythonEnvironment) { Get-FullPath $PythonEnvironment } else { Join-Path $script:ProjectRoot '.venv-qt' }
$preparedPython = Get-PythonEnvironmentPath $preparedPythonRoot
if ($PythonSource) {
    $pythonBaseExecutable = Get-FullPath $PythonSource
    Assert-File $pythonBaseExecutable 'Python base executable'
    $pythonBaseInfo = Get-PythonInfo $pythonBaseExecutable
    if ($pythonBaseInfo.Major -ne $preparedPython.Major -or $pythonBaseInfo.Minor -ne $preparedPython.Minor) {
        Fail 'PythonSource and PythonEnvironment must use the same major/minor Python version.'
    }
} else {
    $basePrefix = [string]$preparedPython.BasePrefix
    if (-not $basePrefix) {
        $cfg = Join-Path $preparedPythonRoot 'pyvenv.cfg'
        if (Test-Path -LiteralPath $cfg -PathType Leaf) {
            $homeLine = Get-Content -LiteralPath $cfg | Where-Object { $_ -match '^\s*home\s*=\s*(.+)$' } | Select-Object -First 1
            if ($homeLine) { $basePrefix = $Matches[1].Trim() }
        }
    }
    if (-not $basePrefix) { Fail 'Could not determine the base Python installation for the prepared environment.' }
    $pythonBaseExecutable = Join-Path (Get-FullPath $basePrefix) 'python.exe'
    Assert-File $pythonBaseExecutable 'Python base executable'
}

Write-Host "Building native launcher..."
$powershell = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
Invoke-Native $powershell @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $script:ProjectRoot 'desktop-qt/build-launcher.ps1')) 'native launcher build'
$launcher = Join-Path $script:ProjectRoot 'Go-Antigravity.exe'
Assert-File $launcher 'built Go-Antigravity.exe'

$stageBackend = Join-Path $stage 'backend'
$stageDesktop = Join-Path $stage 'desktop-qt'
$stageRuntimeNode = Join-Path $stage 'runtime/node'
$stageRuntimePython = Join-Path $stage 'runtime/python'
New-Item -ItemType Directory -Path $stage,$stageBackend,$stageDesktop,$stageRuntimeNode,$stageRuntimePython -Force | Out-Null

Copy-FileSafe $launcher (Join-Path $stage 'Go-Antigravity.exe')
Copy-FileSafe (Join-Path $script:ProjectRoot 'Start-Go-Antigravity.ps1') (Join-Path $stage 'Start-Go-Antigravity.ps1')
Copy-FileSafe (Join-Path $script:ProjectRoot 'Start-Go-Antigravity.cmd') (Join-Path $stage 'Start-Go-Antigravity.cmd')
foreach ($document in @('README.md', 'PORTABLE.md', 'LICENSE')) {
    Copy-FileSafe (Join-Path $script:ProjectRoot $document) (Join-Path $stage $document)
}
Copy-FileSafe (Join-Path $script:ProjectRoot 'backend/THIRD-PARTY-NOTICES.md') (Join-Path $stage 'THIRD-PARTY-NOTICES.md')

Copy-TreeFiltered (Join-Path $script:ProjectRoot 'desktop-qt') $stageDesktop -Include {
    param($Item, $Relative)
    Should-CopyDesktopItem $Item $Relative
}
Copy-TreeFiltered (Join-Path $script:ProjectRoot 'backend') $stageBackend -Include {
    param($Item, $Relative)
    Should-CopyBackendItem $Item $Relative
}

Copy-FileSafe $node.Path (Join-Path $stageRuntimeNode 'node.exe')
Copy-FileSafe (Join-Path $script:ProjectRoot 'backend/NODE-LICENSE.txt') (Join-Path $stageRuntimeNode 'NODE-LICENSE.txt')
Copy-PythonRuntime $pythonBaseExecutable $preparedPythonRoot $preparedPython $stageRuntimePython

$npmCli = Get-NpmCliPath $node.Path
Write-Host 'Installing production backend dependencies into the release package...'
Invoke-Native $node.Path @($npmCli, 'ci', '--prefix', $stageBackend, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund') 'production npm install'

$packageVersion = Get-PackageVersion $Version
$manifest = [ordered]@{
    package = 'Go-Antigravity'
    version = $packageVersion
    platform = 'windows-x64'
    commit = Get-GitCommit
    builtAt = [DateTime]::UtcNow.ToString('o')
    launcher = 'Go-Antigravity.exe'
    dataDirectory = '%LOCALAPPDATA%\Go-Antigravity'
    node = [ordered]@{ version = $node.Version; executable = 'runtime/node/node.exe' }
    python = [ordered]@{ version = $preparedPython.Version; executable = 'runtime/python/pythonw.exe'; importPath = "runtime/python/python$($preparedPython.Major)$($preparedPython.Minor)._pth" }
    backend = [ordered]@{ entry = 'backend/server.js'; dependencies = 'backend/node_modules' }
}
New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') -Force | Out-Null
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stage 'runtime/manifest.json') -Encoding UTF8

$forbidden = Get-ChildItem -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
    $_.FullName -match '(\\|/)(\.git|\.go-antigravity-data|__pycache__|test|backups|_attic)(\\|/)' -or
    $_.Name -match '(^|\.)(log|bak)$'
}
if ($forbidden) {
    $names = ($forbidden | Select-Object -First 10 -ExpandProperty FullName) -join '; '
    Fail "forbidden development or user data entered the package: $names"
}

Write-Host 'Creating ZIP archive...'
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal -Force
Assert-File $zip 'release ZIP'
Write-Host "Created $stage"
Write-Host "Created $zip"
