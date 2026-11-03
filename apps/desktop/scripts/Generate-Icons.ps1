[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$desktopPath = Split-Path -Parent $PSScriptRoot
$iconPath = Join-Path $desktopPath 'src-tauri/icons'
$source = Join-Path $iconPath 'orb.svg'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Tracked 妥啦 Orb SVG source is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $desktopPath 'node_modules/@tauri-apps/cli'))) { throw 'Install the locked desktop dependencies before generating icons.' }

# Only regenerates this application's icon assets; does not compile the app,
# install packages, modify Android's launcher, or touch shared build caches.
& pnpm --dir $desktopPath tauri icon $source --output $iconPath
if ($LASTEXITCODE -ne 0) { throw ('Tauri icon generation failed with exit code ' + $LASTEXITCODE) }
foreach ($required in @('32x32.png','128x128.png','128x128@2x.png','icon.png','icon.ico','icon.icns')) {
  if (-not (Test-Path -LiteralPath (Join-Path $iconPath $required) -PathType Leaf)) { throw ('Generated icon is missing: ' + $required) }
}
Write-Host '妥啦 desktop icon assets regenerated from icons/orb.svg.'
