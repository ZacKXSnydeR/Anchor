$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$CoreDir = Join-Path $RootDir "anchor-core"
$ExtDir = Join-Path $RootDir "anchor-extension"
$UiDir = Join-Path $RootDir "anchor-ui"
$BinDir = Join-Path $ExtDir "bin"

if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir | Out-Null
}

function Invoke-TargetBuild {
    param(
        [Parameter(Mandatory=$true)][string]$Target,
        [Parameter(Mandatory=$true)][string]$OutputName
    )

    $binaryName = if ($Target -like "*windows*") { "anchor-core.exe" } else { "anchor-core" }

    Write-Host "Building anchor-core for $Target..."
    try {
        cargo build --manifest-path (Join-Path $CoreDir "Cargo.toml") --release --target $Target
        $src = Join-Path $CoreDir ("target/{0}/release/{1}" -f $Target, $binaryName)
        if (Test-Path $src) {
            Copy-Item -Force $src (Join-Path $BinDir $OutputName)
            Write-Host "Copied $OutputName"
        } else {
            Write-Warning "Expected binary not found at $src"
        }
    } catch {
        Write-Warning "Failed to build target $Target (continuing)"
    }
}

Invoke-TargetBuild -Target "x86_64-unknown-linux-gnu" -OutputName "anchor-core-linux-x64"
Invoke-TargetBuild -Target "x86_64-apple-darwin" -OutputName "anchor-core-darwin-x64"
Invoke-TargetBuild -Target "aarch64-apple-darwin" -OutputName "anchor-core-darwin-arm64"
Invoke-TargetBuild -Target "x86_64-pc-windows-msvc" -OutputName "anchor-core-win32-x64.exe"

Push-Location $ExtDir
npm install
npm run compile
Pop-Location

Push-Location $UiDir
npm install
npm run build
Pop-Location

Push-Location $ExtDir
npx vsce package
Pop-Location

Write-Host "Build pipeline complete."
